"""Host-side codec for the FarmOS Web Serial enrollment protocol v1.

The board owns the attestation private key.  This module only handles the
bounded UART envelope and deterministic hardware-proof/ticket helpers; it
never accepts or serializes private key material.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import struct
import zlib
from dataclasses import dataclass
from typing import Any


PROTOCOL_VERSION = 1
MAX_PAYLOAD = 2048
SYNC = b"FO"
HEADER_SIZE = 8  # version, type, payload length (u16 BE), sequence (u32 BE)
CRC_SIZE = 4
HARDWARE_PROOF_DOMAIN = b"farmos-enrollment-hardware-v1"
FLASH_ATTESTATION_DOMAIN = "farmos-web-serial-flash-attestation"


class EnrollmentProtocolError(ValueError):
    """Raised when a host frame is malformed or exceeds protocol bounds."""


@dataclass(frozen=True)
class Frame:
    frame_type: int
    sequence: int
    payload: bytes
    version: int = PROTOCOL_VERSION

    def json(self) -> Any:
        try:
            return json.loads(self.payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise EnrollmentProtocolError("frame payload is not UTF-8 JSON") from error


def _crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def _json_bytes(payload: bytes | bytearray | str | dict[str, Any]) -> bytes:
    if isinstance(payload, dict):
        # Ticket signatures cover the exact bytes in the base64 payload.  The
        # host helper therefore uses a stable compact representation whenever
        # it is asked to render a JSON object.
        return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if isinstance(payload, str):
        return payload.encode("utf-8")
    return bytes(payload)


def encode_frame(frame_type: int, payload: bytes | bytearray | str | dict[str, Any],
                 sequence: int, *, version: int = PROTOCOL_VERSION) -> bytes:
    """Encode one bounded ``FO`` frame with a big-endian CRC-32."""
    if not 0 <= version <= 0xFF:
        raise EnrollmentProtocolError("protocol version must fit u8")
    if not 0 <= frame_type <= 0xFF:
        raise EnrollmentProtocolError("frame type must fit u8")
    if not 1 <= sequence <= 0xFFFFFFFF:
        raise EnrollmentProtocolError("sequence must be a non-zero u32")
    body = _json_bytes(payload)
    if not body or len(body) > MAX_PAYLOAD:
        raise EnrollmentProtocolError("payload must be 1..2048 bytes")
    header = struct.pack(">BBHI", version, frame_type, len(body), sequence)
    return SYNC + header + body + struct.pack(">I", _crc32(header + body))


class FrameDecoder:
    """Incremental bounded decoder suitable for Web Serial chunks."""

    def __init__(self, *, max_payload: int = MAX_PAYLOAD,
                 enforce_sequence: bool = True) -> None:
        if not 1 <= max_payload <= MAX_PAYLOAD:
            raise EnrollmentProtocolError("max_payload is outside protocol bounds")
        self.max_payload = max_payload
        self.enforce_sequence = enforce_sequence
        self._buffer = bytearray()
        self._last_sequence = 0

    @property
    def last_sequence(self) -> int:
        return self._last_sequence

    def feed(self, chunk: bytes | bytearray) -> list[Frame]:
        self._buffer.extend(chunk)
        frames: list[Frame] = []
        while True:
            sync_at = self._buffer.find(SYNC)
            if sync_at < 0:
                # Retain a possible first sync byte split across serial reads.
                if self._buffer[-1:] == SYNC[:1]:
                    del self._buffer[:-1]
                else:
                    self._buffer.clear()
                break
            if sync_at:
                del self._buffer[:sync_at]
            if len(self._buffer) < len(SYNC) + HEADER_SIZE:
                break
            header_start = len(SYNC)
            version, frame_type, payload_len, sequence = struct.unpack(
                ">BBHI", self._buffer[header_start:header_start + HEADER_SIZE]
            )
            if version != PROTOCOL_VERSION or payload_len > self.max_payload:
                del self._buffer[:len(SYNC)]
                continue
            frame_size = len(SYNC) + HEADER_SIZE + payload_len + CRC_SIZE
            if len(self._buffer) < frame_size:
                break
            frame_bytes = bytes(self._buffer[:frame_size])
            body_start = len(SYNC) + HEADER_SIZE
            payload = frame_bytes[body_start:body_start + payload_len]
            supplied_crc = struct.unpack(">I", frame_bytes[-CRC_SIZE:])[0]
            expected_crc = _crc32(frame_bytes[len(SYNC):-CRC_SIZE])
            del self._buffer[:frame_size]
            if expected_crc != supplied_crc:
                continue
            if self.enforce_sequence and (sequence == 0 or sequence <= self._last_sequence):
                continue
            self._last_sequence = sequence
            frames.append(Frame(frame_type, sequence, payload, version))
        return frames


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def b64url_decode(value: str) -> bytes:
    if not value or any(character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_="
                         for character in value):
        raise EnrollmentProtocolError("invalid base64url")
    if "=" in value.rstrip("="):
        raise EnrollmentProtocolError("invalid base64url padding")
    try:
        return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))
    except (ValueError, binascii.Error) as error:
        raise EnrollmentProtocolError("invalid base64url") from error


def _length_prefix(value: bytes) -> bytes:
    return struct.pack(">I", len(value)) + value


def hardware_proof(chip_family: str, efuse_mac: bytes, nonce: bytes) -> str:
    """Return the lowercase SHA-256 proof advertised by board HELLO."""
    if not chip_family or len(efuse_mac) != 6 or not 1 <= len(nonce) <= 64:
        raise EnrollmentProtocolError("invalid hardware-proof inputs")
    transcript = b"".join((
        _length_prefix(HARDWARE_PROOF_DOMAIN),
        _length_prefix(chip_family.encode("utf-8")),
        _length_prefix(efuse_mac),
        _length_prefix(nonce),
    ))
    return hashlib.sha256(transcript).hexdigest()


def canonical_json(value: dict[str, Any]) -> bytes:
    """Render the exact compact sorted JSON bytes covered by ticket signatures."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def ticket_payload_base64(value: dict[str, Any]) -> str:
    return b64url_encode(canonical_json(value))


def flash_attestation_message(*, board_id: str, job_id: str, release_id: str,
                              manifest_sha256: str, readback_sha256: str,
                              challenge: str) -> str:
    """Render the exact JSON verified by the backend FlashJob completion route."""
    values = (board_id, job_id, release_id, challenge)
    if any(not value or len(value) > 512 or any(ord(character) < 0x20 for character in value)
           for value in values):
        raise EnrollmentProtocolError("flash attestation identifiers are invalid")
    for digest in (manifest_sha256, readback_sha256):
        if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            raise EnrollmentProtocolError("flash attestation digests must be lowercase SHA-256 hex")
    return json.dumps({
        "v": 1,
        "domain": FLASH_ATTESTATION_DOMAIN,
        "boardId": board_id,
        "jobId": job_id,
        "releaseId": release_id,
        "manifestSha256": manifest_sha256,
        "readbackSha256": readback_sha256,
        "challenge": challenge,
    }, separators=(",", ":"), ensure_ascii=True)


def firmware_target_requires_p256(target: str) -> bool:
    """Mirror the firmware/backend target contract for serial tickets."""
    normalized = target.strip().upper()
    if not normalized or "ED25519" in normalized:
        return False
    return "ECDSA" in normalized or "P256" in normalized or normalized.startswith("ESP32S3_LORA_")


def reflash_ticket_digest(ticket: dict[str, Any]) -> str:
    """Hash the exact signed payload used as the volatile REFLASH replay marker."""
    return hashlib.sha256(canonical_json(ticket)).hexdigest()


def reflash_ticket_matches_identity(ticket: dict[str, Any], identity: dict[str, Any]) -> bool:
    """Mirror firmware's non-mutating REFLASH identity/key binding policy."""
    fingerprint = identity.get("publicKeyFingerprint")
    return (
        ticket.get("operation") == "REFLASH"
        and ticket.get("physicalSerial") is True
        and ticket.get("identityVersion") == identity.get("identityVersion")
        and ticket.get("generation") == identity.get("keyGeneration")
        and ticket.get("deviceId") == identity.get("deviceId")
        and ticket.get("serial") == identity.get("serial")
        and ticket.get("model") == identity.get("model")
        and ticket.get("hardwareRevision") == identity.get("hardwareRevision")
        and ticket.get("firmwareTarget") == identity.get("firmwareTarget")
        and isinstance(fingerprint, str)
        and len(fingerprint) == 64
        and ticket.get("publicKeyFingerprint") == fingerprint
        and ticket.get("currentPublicKeyFingerprint") == fingerprint
        and firmware_target_requires_p256(str(identity.get("firmwareTarget", "")))
    )


def reflash_ticket_accepts(ticket: dict[str, Any], identity: dict[str, Any],
                           previous_digest: str | None = None) -> bool:
    """Return whether a REFLASH ticket is bound to this identity and not replayed."""
    digest = reflash_ticket_digest(ticket)
    return reflash_ticket_matches_identity(ticket, identity) and digest != previous_digest
