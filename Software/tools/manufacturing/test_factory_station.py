import base64
import argparse
import hashlib
import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
import factory_station


class FactoryStationTest(unittest.TestCase):
    def test_attestation_vector_matches_backend_message_contract(self):
        vector = json.loads((Path(__file__).with_name("attestation_v3_vector.json")).read_text())
        self.assertEqual(vector["signatureFormat"], "transcript-v1")
        self.assertIn("attestationMessage", vector["backendAttest"]["verificationMessage"])
        self.assertEqual(vector["wireEncoding"]["signature"], "base64url without padding of DER ECDSA P-256 signature")
        self.assertIn("provisioningToken", vector["challengeRequest"])
        self.assertIn("provisioningToken", vector["configBinding"])
        self.assertNotIn("challenge", vector["challengeResponseFields"])

        request = vector["challengeRequest"]

        def part(value):
            return struct.pack(">I", len(value)) + value

        transcript = b"".join((
            part(vector["canonicalTranscript"]["domain"].encode()),
            part(request["deviceId"].encode()),
            part(request["sessionId"].encode()),
            part(hashlib.sha256(request["provisioningToken"].encode()).digest()),
            part(base64.urlsafe_b64decode(request["nonce"] + "==")),
            struct.pack(">I", 3),
        ))
        self.assertEqual(hashlib.sha256(transcript).hexdigest(), vector["vector"]["transcriptDigest"])
        public_der = base64.b64decode(vector["vector"]["publicKeySpki"])
        self.assertEqual(hashlib.sha256(public_der).hexdigest(), vector["vector"]["publicKeyFingerprint"])
        self.assertTrue(vector["vector"]["signature"] and "=" not in vector["vector"]["signature"])

    def test_station_credential_file_enforces_private_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "credential.json"
            path.write_text(json.dumps({"stationId": "station", "stationToken": "test-only", "baseUrl": "https://example.com"}))
            args = argparse.Namespace(credential_file=str(path))
            path.chmod(0o644)
            with self.assertRaises(factory_station.StationError):
                factory_station.station_credentials(args)
            path.chmod(0o600)
            self.assertEqual(factory_station.station_credentials(args)["stationId"], "station")
            path.write_text(json.dumps({"stationId": "station", "stationToken": "test-only", "baseUrl": "http://example.com"}))
            with self.assertRaises(factory_station.StationError):
                factory_station.station_credentials(args)

    def test_default_firmware_target_follows_device_type(self):
        common = {
            "quantity": 1, "device_id": None, "radio_id": None,
            "serial": None, "serial_prefix": "FARMOS", "model": "MODEL",
            "hardware_revision": "REV_A", "firmware_target": None,
            "partition_scheme": "FARMOS_16M_V1", "capabilities": None,
        }
        node = factory_station.requested_identities(argparse.Namespace(**common, type="SENSOR_NODE"))
        gateway = factory_station.requested_identities(argparse.Namespace(**common, type="GATEWAY"))
        self.assertEqual(node[0]["firmwareTarget"], "ESP32S3_LORA_SENSOR_V1")
        self.assertEqual(gateway[0]["firmwareTarget"], "ESP32S3_LORA_GATEWAY_V1")

    def test_node_numeric_radio_constraint(self):
        self.assertEqual(factory_station.validate_node_device_id("NODE_000007"), 7)
        self.assertEqual(factory_station.validate_node_device_id("NODE_7", 7), 7)
        with self.assertRaises(factory_station.StationError):
            factory_station.validate_node_device_id("NODE_A7")
        with self.assertRaises(factory_station.StationError):
            factory_station.validate_node_device_id("NODE_000007", 8)

    def test_gateway_numeric_id_constraint(self):
        self.assertEqual(factory_station.validate_gateway_device_id("GATEWAY_000007"), 7)
        with self.assertRaises(factory_station.StationError):
            factory_station.validate_gateway_device_id("GATEWAY_A7")
        with self.assertRaises(factory_station.StationError):
            factory_station.validate_gateway_device_id("GATEWAY_00000000000000000000000000000000000")

    def test_key_generation_and_payload_never_contains_private_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            private_path, public_path, public_key, fingerprint = factory_station.generate_attestation_keypair(directory, "NODE_000001")
            manifest = {
                "identityVersion": 3, "batchId": "batch", "deviceId": "NODE_000001", "serial": "SN-1",
                "type": "SENSOR_NODE", "model": "model", "hardwareRevision": "REV_A",
                "firmwareTarget": "target", "partitionScheme": "FARMOS_16M_V1", "radioId": 1,
                "publicKey": public_key, "publicKeyFingerprint": fingerprint,
                "privateKeyFile": str(private_path), "publicKeyFile": str(public_path),
                "outputDir": str(directory), "claimCode": "claim-only",
            }
            payload = factory_station.factory_write_payload(manifest)
            self.assertNotIn("privateKeyFile", json.dumps(payload))
            self.assertNotIn(private_path.read_bytes().hex(), json.dumps(payload))
            self.assertEqual(base64.b64decode(payload["publicKey"]), public_path.read_bytes())
            self.assertGreater(len(private_path.read_bytes()), 32)
            self.assertEqual(factory_station.local_verify(manifest)["publicKeyAlgorithm"], "ECDSA-P256")

    def test_nvs_rows_contain_factory_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            private_path = directory / "private.raw"
            public_path = directory / "public.raw"
            private_path.write_bytes(b"p" * 32)
            public_path.write_bytes(b"u" * 32)
            manifest = {
                "identityVersion": 3, "deviceId": "NODE_000001", "serial": "SN-1", "type": "SENSOR_NODE",
                "model": "model", "hardwareRevision": "REV_A", "firmwareTarget": "target",
                "publicKeyFingerprint": "a" * 64, "privateKeyFile": str(private_path),
                "publicKeyFile": str(public_path), "radioId": 1,
            }
            fields = {row[0]: row[3] for row in factory_station.nvs_rows(manifest)[2:]}
            self.assertTrue(all(len(key) <= 15 for key in fields))
            self.assertEqual(fields["device_id"], "NODE_000001")
            self.assertEqual(fields["radio_id"], "1")
            self.assertEqual(fields[factory_station.NVS_IDENTITY_KEYS["attestation_public_key"]], (b"u" * 32).hex())
            self.assertEqual(fields[factory_station.NVS_IDENTITY_KEYS["attestation_private_key"]], (b"p" * 32).hex())

    def test_readback_evidence_binds_identity_partition_and_firmware(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            image = directory / "factory_cfg.bin"
            readback = directory / "factory_cfg.readback.bin"
            firmware = directory / "firmware.bin"
            image.write_bytes(b"factory-image")
            readback.write_bytes(b"factory-image")
            firmware.write_bytes(b"signed-release-artifact")
            manifest = {
                "identityVersion": 3, "deviceId": "NODE_000007", "serial": "SN-7",
                "type": "SENSOR_NODE", "model": "model", "hardwareRevision": "REV_A",
                "firmwareTarget": "ESP32S3_LORA_SENSOR_V1", "partitionScheme": "FARMOS_16M_V1",
                "capabilities": ["WIFI", "LORA"], "radioId": 7,
                "publicKeyAlgorithm": "ECDSA-P256", "publicKey": "public",
                "publicKeyFingerprint": "a" * 64,
            }
            evidence = factory_station.readback_evidence(manifest, image, readback, firmware, "station-01")
            self.assertEqual(evidence["stationId"], "station-01")
            self.assertTrue(evidence["partitionProof"]["matches"])
            self.assertEqual(evidence["partitionProof"]["offset"], factory_station.FACTORY_CFG_OFFSET)
            self.assertEqual(evidence["firmware"]["artifactSha256"], hashlib.sha256(firmware.read_bytes()).hexdigest())
            self.assertIn("evidenceSha256", evidence)
            self.assertNotIn("privateKeyFile", json.dumps(evidence))

    def test_loaded_evidence_requires_matching_files_and_physical_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            image = directory / "factory_cfg.bin"
            readback = directory / "factory_cfg.readback.bin"
            firmware = directory / "firmware.bin"
            image.write_bytes(
                b"factory-image" * (factory_station.FACTORY_CFG_SIZE // 13)
                + b"x" * (factory_station.FACTORY_CFG_SIZE % 13)
            )
            readback.write_bytes(image.read_bytes())
            firmware.write_bytes(b"signed-release-artifact")
            manifest = {
                "identityVersion": 3, "deviceId": "NODE_000007", "serial": "SN-7",
                "type": "SENSOR_NODE", "model": "model", "hardwareRevision": "REV_A",
                "firmwareTarget": "ESP32S3_LORA_SENSOR_V1", "partitionScheme": "FARMOS_16M_V1",
                "capabilities": ["WIFI", "LORA"], "radioId": 7,
                "publicKeyAlgorithm": "ECDSA-P256", "publicKey": "public",
                "publicKeyFingerprint": "a" * 64, "outputDir": str(directory),
            }
            evidence = factory_station.readback_evidence(
                manifest, image, readback, firmware, "station-01",
                readback_source="fixture", strict_size=True,
            )
            (directory / "readback.json").write_text(
                json.dumps({"deviceId": manifest["deviceId"], **evidence}), encoding="utf-8"
            )
            loaded = factory_station.load_readback_evidence(manifest)
            self.assertEqual(loaded["evidenceSha256"], evidence["evidenceSha256"])
            with self.assertRaises(factory_station.StationError):
                factory_station.load_readback_evidence(manifest, require_physical=True)
            readback.write_bytes(b"tampered" + readback.read_bytes()[8:])
            with self.assertRaises(factory_station.StationError):
                factory_station.load_readback_evidence(manifest)


if __name__ == "__main__":
    unittest.main()
