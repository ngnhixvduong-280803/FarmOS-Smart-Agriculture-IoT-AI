#!/usr/bin/env python3
"""Generate the non-secret firmware configuration overlay.

The repository root ``.env`` is the source of public release configuration.
Only the enrollment verification public key is emitted into an ESP-IDF
``sdkconfig`` overlay. Runtime API URLs are intentionally not compiled into
the image: authenticated mobile provisioning supplies that value to the board
over the attested BLE channel.

This module has no dependency on backend or private-key tooling. It validates
the SPKI DER shape directly so a production build cannot silently ship
without an ECDSA P-256 trust anchor.
"""

from __future__ import annotations

import argparse
import base64
import os
import re
from pathlib import Path
from typing import Mapping


PUBLIC_KEY_ENV = "FIRMWARE_ENROLLMENT_SERVER_PUBLIC_KEY"
CANONICAL_PUBLIC_KEY_ENV = "FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY"
API_URL_ENV = "FARMOS_API_URL"
_PUBLIC_ENV_NAMES = frozenset((PUBLIC_KEY_ENV, CANONICAL_PUBLIC_KEY_ENV, API_URL_ENV))
PROFILES = frozenset(("dev", "production"))
_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_KEY_LINE = "CONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY"


class FirmwareConfigError(ValueError):
    """Raised when public firmware configuration is missing or malformed."""


def parse_dotenv(path: Path) -> dict[str, str]:
    """Read simple dotenv assignments without expanding or exposing secrets."""

    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise FirmwareConfigError(f"invalid dotenv assignment at {path}:{line_number}")
        name, value = line.split("=", 1)
        name = name.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise FirmwareConfigError(f"invalid dotenv name at {path}:{line_number}")
        # Ignore every non-public assignment before touching its value. This
        # prevents private keys/secrets from being copied into generator state.
        if name not in _PUBLIC_ENV_NAMES:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[name] = value
    return values


def _der_length(data: bytes, offset: int) -> tuple[int, int]:
    if offset >= len(data):
        raise FirmwareConfigError("SPKI DER is truncated")
    first = data[offset]
    offset += 1
    if first < 0x80:
        return first, offset
    count = first & 0x7F
    if count == 0 or count > 4 or offset + count > len(data):
        raise FirmwareConfigError("SPKI DER length is invalid")
    if data[offset] == 0:
        raise FirmwareConfigError("SPKI DER length is not canonical")
    length = int.from_bytes(data[offset:offset + count], "big")
    return length, offset + count


def _der_tlv(data: bytes, offset: int, tag: int) -> tuple[bytes, int]:
    if offset >= len(data) or data[offset] != tag:
        raise FirmwareConfigError("SPKI DER algorithm structure is invalid")
    length, value_offset = _der_length(data, offset + 1)
    end = value_offset + length
    if end > len(data):
        raise FirmwareConfigError("SPKI DER value is truncated")
    return data[value_offset:end], end


def validate_p256_spki_base64url(value: str) -> str:
    """Validate and return a canonical unpadded base64url SPKI P-256 key."""

    candidate = value.strip()
    if not candidate or "=" in candidate or not _BASE64URL.fullmatch(candidate):
        raise FirmwareConfigError(f"{PUBLIC_KEY_ENV} must be unpadded base64url")
    try:
        decoded = base64.urlsafe_b64decode(candidate + "=" * ((4 - len(candidate) % 4) % 4))
    except (ValueError, base64.binascii.Error) as error:
        raise FirmwareConfigError(f"{PUBLIC_KEY_ENV} is not valid base64url") from error
    if base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != candidate:
        raise FirmwareConfigError(f"{PUBLIC_KEY_ENV} is not canonical base64url")

    # SubjectPublicKeyInfo ::= SEQUENCE {
    #   algorithm       SEQUENCE { id-ecPublicKey, prime256v1 },
    #   subjectPublicKey BIT STRING (00 || 04 || X || Y)
    # }
    outer, end = _der_tlv(decoded, 0, 0x30)
    if end != len(decoded):
        raise FirmwareConfigError("SPKI DER has trailing bytes")
    algorithm, offset = _der_tlv(outer, 0, 0x30)
    algorithm_oid, algorithm_offset = _der_tlv(algorithm, 0, 0x06)
    curve_oid, algorithm_offset = _der_tlv(algorithm, algorithm_offset, 0x06)
    if algorithm_offset != len(algorithm) or algorithm_oid != bytes.fromhex("2a8648ce3d0201") or curve_oid != bytes.fromhex("2a8648ce3d030107"):
        raise FirmwareConfigError(f"{PUBLIC_KEY_ENV} must be an ECDSA P-256 SPKI")
    bit_string, offset = _der_tlv(outer, offset, 0x03)
    if offset != len(outer) or len(bit_string) != 66 or bit_string[:2] != b"\x00\x04":
        raise FirmwareConfigError(f"{PUBLIC_KEY_ENV} must contain an uncompressed P-256 public point")
    return candidate


def _effective_values(dotenv: Mapping[str, str], environ: Mapping[str, str] | None) -> dict[str, str]:
    values = dict(dotenv)
    # Explicit process environment wins over .env. This lets CI inject the
    # approved public key without writing or copying any private material.
    process_env = os.environ if environ is None else environ
    for name in _PUBLIC_ENV_NAMES:
        if name in process_env:
            values[name] = process_env[name]
    return values


def public_config_from_env(path: Path, profile: str, *, environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return public material for a profile; never returns private dotenv values."""

    if profile not in PROFILES:
        raise FirmwareConfigError(f"profile must be one of {sorted(PROFILES)}")
    values = _effective_values(parse_dotenv(path), environ)
    key = values.get(PUBLIC_KEY_ENV, "").strip()
    canonical_key = values.get(CANONICAL_PUBLIC_KEY_ENV, "").strip()
    if key:
        key = validate_p256_spki_base64url(key)
    if canonical_key:
        canonical_key = validate_p256_spki_base64url(canonical_key)
    if key and canonical_key and key != canonical_key:
        raise FirmwareConfigError(
            f"{PUBLIC_KEY_ENV} does not match {CANONICAL_PUBLIC_KEY_ENV}"
        )
    # The backend's canonical public value is the source of truth. The
    # firmware-specific name remains an explicit override for isolated build
    # environments, but duplicating a different value is rejected above.
    key = key or canonical_key
    if profile == "production" and not key:
        raise FirmwareConfigError(
            f"{PUBLIC_KEY_ENV} or {CANONICAL_PUBLIC_KEY_ENV} is required for production firmware"
        )
    return {PUBLIC_KEY_ENV: key}


def render_sdkconfig_overlay(config: Mapping[str, str], profile: str) -> str:
    """Render only the safe public key into an ESP-IDF defaults fragment."""

    if profile not in PROFILES:
        raise FirmwareConfigError(f"profile must be one of {sorted(PROFILES)}")
    key = str(config.get(PUBLIC_KEY_ENV, ""))
    if key:
        key = validate_p256_spki_base64url(key)
    elif profile == "production":
        raise FirmwareConfigError(f"{PUBLIC_KEY_ENV} is required for production firmware")
    return (
        "# GENERATED by tools/firmware_config.py; do not edit or commit.\n"
        f"# profile={profile}; runtime API URL is supplied by authenticated mobile provisioning.\n"
        f'{_KEY_LINE}="{key}"\n'
    )


def validate_generated_overlay(path: Path, config: Mapping[str, str], profile: str) -> None:
    """Fail if an overlay is absent, stale, or contains non-public config."""

    if not path.exists():
        raise FirmwareConfigError(f"generated firmware overlay is missing: {path}")
    text = path.read_text(encoding="utf-8")
    expected = render_sdkconfig_overlay(config, profile)
    if text != expected:
        raise FirmwareConfigError(f"generated firmware overlay is stale or mismatched: {path}")
    forbidden = (
        "FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY",
        "FIRMWARE_MANIFEST_SIGNING_KEY",
        "HARDWARE_BOARD_HMAC_SECRET",
        "DATABASE_URL",
        "JWT_SECRET",
        "MQTT_PASSWORD",
    )
    if any(name in text for name in forbidden):
        raise FirmwareConfigError("generated firmware overlay contains secret configuration")


def sync_platformio_sdkconfig(path: Path, config: Mapping[str, str], profile: str) -> None:
    """Synchronize the generated trust anchor into PlatformIO's active sdkconfig.

    ESP-IDF defaults only populate options that are absent from an existing
    sdkconfig. PlatformIO retains that generated file between builds, so an
    earlier empty development value otherwise overrides a newly generated
    public-key overlay forever. Keep the active value aligned and touch the
    file so PlatformIO reconfigures CMake before compiling the artifact.
    """

    if profile not in PROFILES:
        raise FirmwareConfigError(f"profile must be one of {sorted(PROFILES)}")
    key = str(config.get(PUBLIC_KEY_ENV, ""))
    if key:
        key = validate_p256_spki_base64url(key)
    elif profile == "production":
        raise FirmwareConfigError(f"{PUBLIC_KEY_ENV} is required for production firmware")

    replacement = f'{_KEY_LINE}="{key}"'
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    pattern = re.compile(rf"(?m)^{re.escape(_KEY_LINE)}=.*$")
    if pattern.search(text):
        updated = pattern.sub(replacement, text)
    else:
        separator = "" if not text or text.endswith("\n") else "\n"
        updated = f"{text}{separator}{replacement}\n"
    if updated != text:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(updated, encoding="utf-8")


def validate_firmware_artifact(path: Path, config: Mapping[str, str], profile: str) -> None:
    """Reject a firmware binary that omitted its configured trust anchor."""

    key = str(config.get(PUBLIC_KEY_ENV, ""))
    if not key:
        if profile == "production":
            raise FirmwareConfigError(f"{PUBLIC_KEY_ENV} is required for production firmware")
        return
    if not path.exists() or key.encode("ascii") not in path.read_bytes():
        raise FirmwareConfigError(
            "compiled firmware does not contain the configured enrollment public key"
        )


def generate_overlay(env_file: Path, output: Path, profile: str, *, environ: Mapping[str, str] | None = None) -> Path:
    config = public_config_from_env(env_file, profile, environ=environ)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_sdkconfig_overlay(config, profile), encoding="utf-8")
    validate_generated_overlay(output, config, profile)
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--profile", choices=sorted(PROFILES), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        generate_overlay(args.env_file, args.output, args.profile)
    except FirmwareConfigError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
