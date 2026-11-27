import hashlib
import json
import struct
import unittest
from copy import deepcopy
from pathlib import Path

from enrollment_protocol import (
    FrameDecoder,
    EnrollmentProtocolError,
    MAX_PAYLOAD,
    b64url_decode,
    b64url_encode,
    canonical_json,
    encode_frame,
    flash_attestation_message,
    firmware_target_requires_p256,
    hardware_proof,
    reflash_ticket_accepts,
    reflash_ticket_digest,
    reflash_ticket_matches_identity,
    ticket_payload_base64,
)


class EnrollmentProtocolTest(unittest.TestCase):
    def test_frame_round_trip_across_serial_chunks(self):
        frame = encode_frame(3, {"op": "ENROLLMENT_TICKET", "ticketId": "ticket-1"}, 7)
        decoder = FrameDecoder()
        decoded = []
        for offset in range(0, len(frame), 3):
            decoded.extend(decoder.feed(frame[offset:offset + 3]))
        self.assertEqual(len(decoded), 1)
        self.assertEqual(decoded[0].frame_type, 3)
        self.assertEqual(decoded[0].sequence, 7)
        self.assertEqual(decoded[0].json(), {"op": "ENROLLMENT_TICKET", "ticketId": "ticket-1"})

    def test_decoder_resynchronizes_after_logs_and_bad_crc(self):
        valid = encode_frame(2, {"op": "HELLO_REQUEST"}, 2)
        bad = bytearray(encode_frame(2, {"op": "HELLO_REQUEST"}, 1))
        bad[-1] ^= 0x01
        decoder = FrameDecoder()
        frames = decoder.feed(b"boot log\r\n" + bytes(bad) + b"noise" + valid)
        self.assertEqual([(frame.frame_type, frame.sequence) for frame in frames], [(2, 2)])

    def test_decoder_rejects_replayed_sequence(self):
        decoder = FrameDecoder()
        first = encode_frame(2, b'{"op":"HELLO_REQUEST"}', 9)
        replay = encode_frame(2, b'{"op":"HELLO_REQUEST"}', 9)
        self.assertEqual(len(decoder.feed(first)), 1)
        self.assertEqual(decoder.feed(replay), [])
        self.assertEqual(decoder.last_sequence, 9)

    def test_payload_bound_and_sequence_bound(self):
        with self.assertRaises(EnrollmentProtocolError):
            encode_frame(1, b"x" * (MAX_PAYLOAD + 1), 1)
        with self.assertRaises(EnrollmentProtocolError):
            encode_frame(1, b"x", 0)
        with self.assertRaises(EnrollmentProtocolError):
            FrameDecoder(max_payload=MAX_PAYLOAD + 1)

    def test_base64url_has_no_padding_and_round_trips(self):
        value = bytes(range(32))
        encoded = b64url_encode(value)
        self.assertNotIn("=", encoded)
        self.assertEqual(b64url_decode(encoded), value)

    def test_hardware_proof_vector(self):
        vector = json.loads(Path(__file__).with_name("enrollment_v1_vector.json").read_text())
        inputs = vector["hardwareProof"]
        mac = bytes.fromhex(inputs["efuseMac"].replace(":", ""))
        nonce = b64url_decode(inputs["nonce"])
        self.assertEqual(
            hardware_proof(inputs["chipFamily"], mac, nonce),
            inputs["proof"],
        )

    def test_ticket_signature_bytes_are_explicit(self):
        vector = json.loads(Path(__file__).with_name("enrollment_v1_vector.json").read_text())
        payload = vector["ticketPayload"]
        rendered = canonical_json(payload)
        self.assertEqual(ticket_payload_base64(payload), vector["ticketPayloadBase64"])
        self.assertEqual(hashlib.sha256(rendered).hexdigest(), vector["ticketPayloadSha256"])
        self.assertEqual(json.loads(rendered), payload)

    def test_wire_crc_uses_header_and_payload_only(self):
        frame = encode_frame(2, b'{"op":"HELLO_REQUEST"}', 1)
        header = frame[2:10]
        payload_length = struct.unpack(">H", header[2:4])[0]
        payload = frame[10:10 + payload_length]
        supplied = struct.unpack(">I", frame[10 + payload_length:14 + payload_length])[0]
        import zlib
        self.assertEqual(supplied, zlib.crc32(header + payload) & 0xFFFFFFFF)

    def test_firmware_target_contract_is_p256_only(self):
        self.assertTrue(firmware_target_requires_p256("ESP32S3_LORA_SENSOR_V1"))
        self.assertTrue(firmware_target_requires_p256("gateway-p256-release"))
        self.assertFalse(firmware_target_requires_p256("ESP32S3_LORA_ED25519"))
        self.assertFalse(firmware_target_requires_p256("unknown-target"))

    def test_flash_attestation_message_matches_backend_order(self):
        vector = json.loads(Path(__file__).with_name("enrollment_v1_vector.json").read_text())["flashAttestation"]
        message = flash_attestation_message(
            board_id=vector["boardId"],
            job_id=vector["jobId"],
            release_id=vector["releaseId"],
            manifest_sha256=vector["manifestSha256"],
            readback_sha256=vector["readbackSha256"],
            challenge=vector["challenge"],
        )
        self.assertEqual(message, vector["message"])
        self.assertEqual(hashlib.sha256(message.encode("utf-8")).hexdigest(), vector["messageSha256"])

    def test_reflash_ticket_preserves_identity_binding(self):
        vector = json.loads(Path(__file__).with_name("enrollment_v1_vector.json").read_text())
        identity = vector["reflashIdentity"]
        ticket = vector["reflashTicket"]
        self.assertTrue(reflash_ticket_matches_identity(ticket, identity))
        self.assertTrue(reflash_ticket_accepts(ticket, identity))
        self.assertEqual(reflash_ticket_digest(ticket), vector["reflashTicketSha256"])

    def test_reflash_ticket_rejects_mismatches_and_replay(self):
        vector = json.loads(Path(__file__).with_name("enrollment_v1_vector.json").read_text())
        identity = vector["reflashIdentity"]
        ticket = vector["reflashTicket"]
        digest = reflash_ticket_digest(ticket)
        self.assertFalse(reflash_ticket_accepts(ticket, identity, digest))
        for field in ("generation", "deviceId", "publicKeyFingerprint", "currentPublicKeyFingerprint"):
            mutated = deepcopy(ticket)
            mutated[field] = 999 if field == "generation" else "mismatch"
            self.assertFalse(reflash_ticket_matches_identity(mutated, identity), field)
        retry = deepcopy(ticket)
        retry["ticketId"] = "flash-job-reflash-002"
        self.assertTrue(reflash_ticket_accepts(retry, identity, digest))
        self.assertNotEqual(reflash_ticket_digest(retry), digest)


if __name__ == "__main__":
    unittest.main()
