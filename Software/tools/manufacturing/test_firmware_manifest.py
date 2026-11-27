import copy
import json
import tempfile
import unittest
from pathlib import Path

from firmware_manifest import (
    FirmwareManifestError,
    LAYOUT_PATH,
    load_layout,
    manifest_for_build,
    validate_layout,
)


class FirmwareManifestTest(unittest.TestCase):
    def test_authoritative_layout_has_non_overlapping_protected_ranges(self):
        layout = load_layout()
        validate_layout(layout)
        self.assertEqual(layout["partitionTable"]["offset"], 0x10000)
        self.assertEqual(layout["partitions"][0]["offset"], 0x11000)
        self.assertEqual(layout["partitions"][4]["offset"], 0x320000)
        protected = {item["name"]: item for item in layout["protectedRanges"]}
        self.assertEqual((protected["factory_identity"]["offset"], protected["factory_identity"]["sizeBytes"]), (0x620000, 0x10000))
        self.assertEqual((protected["nvs_keys"]["offset"], protected["nvs_keys"]["sizeBytes"]), (0x630000, 0x1000))
        normal_plan = layout["writePlans"]["NORMAL_REFLASH"]
        self.assertEqual([step["role"] for step in normal_plan], ["APP", "OTA_DATA"])
        self.assertEqual(normal_plan[-1]["phase"], "COMMIT_OTA0_LAST")
        self.assertEqual(normal_plan[-1]["selector"], "ota_0")

    def test_layout_rejects_protected_overlap(self):
        layout = load_layout()
        broken = copy.deepcopy(layout)
        broken["partitions"][4]["offset"] = broken["protectedRanges"][0]["offset"]
        with self.assertRaisesRegex(FirmwareManifestError, "overlap"):
            validate_layout(broken)

    def test_layout_rejects_partition_table_collision(self):
        layout = load_layout()
        broken = copy.deepcopy(layout)
        broken["partitions"][0]["offset"] = broken["partitionTable"]["offset"]
        with self.assertRaisesRegex(FirmwareManifestError, "bootloader/partition-table"):
            validate_layout(broken)

    def test_layout_rejects_selector_commit_before_app(self):
        layout = load_layout()
        broken = copy.deepcopy(layout)
        broken["writePlans"]["NORMAL_REFLASH"].reverse()
        with self.assertRaisesRegex(FirmwareManifestError, "write plan must order"):
            validate_layout(broken)

    def test_layout_rejects_protected_role_in_write_plan(self):
        layout = load_layout()
        broken = copy.deepcopy(layout)
        broken["writePlans"]["NORMAL_REFLASH"][0]["role"] = "FACTORY_IDENTITY"
        with self.assertRaisesRegex(FirmwareManifestError, "write plan must order"):
            validate_layout(broken)

    def test_single_usb_profile_never_requires_efuse(self):
        layout = load_layout()
        self.assertEqual(set(layout["targets"]), {"NODE", "GATEWAY"})
        self.assertEqual(layout["targets"]["NODE"]["firmwareTarget"], "ESP32S3_LORA_SENSOR_V1")
        self.assertEqual(layout["targets"]["GATEWAY"]["firmwareTarget"], "ESP32S3_LORA_GATEWAY_V1")
        self.assertEqual(set(layout["profiles"]), {"usb"})
        self.assertTrue(layout["profiles"]["usb"]["requiresOfflineSigning"])
        for flag in ["nvsEncryption", "secureBoot", "flashEncryption", "requiresEfuseProvisioning"]:
            self.assertFalse(layout["profiles"]["usb"][flag])

    def test_build_manifest_hashes_all_four_platformio_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "node"
            build = project / ".pio" / "build" / "node"
            build.mkdir(parents=True)
            (project / "partitions.csv").write_text(
                (Path(__file__).resolve().parents[2] / "firmware" / "node" / "partitions.csv").read_text(),
                encoding="utf-8",
            )
            for name, size in (("bootloader.bin", 64), ("partitions.bin", 32), ("ota_data_initial.bin", 8192), ("firmware.bin", 1024)):
                (build / name).write_bytes(bytes([size & 0xFF]) * size)
            (build / "flasher_args.json").write_text(json.dumps({
                "bootloader": {"offset": "0x0", "file": "bootloader/bootloader.bin"},
                "partition-table": {"offset": "0x10000", "file": "partition_table/partition-table.bin"},
                "otadata": {"offset": "0x19000", "file": "ota_data_initial.bin"},
                "app": {"offset": "0x20000", "file": "farmos_node.bin"},
            }), encoding="utf-8")
            manifest = manifest_for_build(build, "NODE", "usb")
            self.assertEqual([item["role"] for item in manifest["images"]], ["BOOTLOADER", "PARTITION_TABLE", "APP", "OTA_DATA"])
            self.assertEqual(manifest["normalReflash"]["writableRoles"], ["APP", "OTA_DATA"])
            self.assertEqual(manifest["normalReflash"]["readbackOffset"], 0x20000)
            self.assertEqual(manifest["readback"]["length"], 1024)
            self.assertEqual([step["role"] for step in manifest["writePlans"]["NORMAL_REFLASH"]], ["APP", "OTA_DATA"])
            self.assertEqual(manifest["writePlans"]["NORMAL_REFLASH"][-1]["phase"], "COMMIT_OTA0_LAST")
            self.assertEqual(len(manifest["buildManifestSha256"]), 64)

    def test_build_manifest_rejects_bootloader_overflow(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "node"
            build = project / ".pio" / "build" / "node"
            build.mkdir(parents=True)
            (project / "partitions.csv").write_text(
                (Path(__file__).resolve().parents[2] / "firmware" / "node" / "partitions.csv").read_text(),
                encoding="utf-8",
            )
            (build / "bootloader.bin").write_bytes(b"x" * 0x10001)
            (build / "partitions.bin").write_bytes(b"x" * 32)
            (build / "ota_data_initial.bin").write_bytes(b"x" * 8192)
            (build / "firmware.bin").write_bytes(b"x" * 1024)
            (build / "flasher_args.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(FirmwareManifestError, "bootloader artifact exceeds"):
                manifest_for_build(build, "NODE", "usb")

    def test_real_build_manifests_if_platformio_outputs_exist(self):
        build_roots = (
            ("NODE", "usb", Path(__file__).resolve().parents[2] / "firmware/node/.pio/build/node"),
            ("GATEWAY", "usb", Path(__file__).resolve().parents[2] / "firmware/gateway/.pio/build/gateway"),
        )
        for role, profile, build in build_roots:
            if not build.is_dir():
                continue
            manifest = manifest_for_build(build, role, profile)
            self.assertEqual(manifest["partitionTableOffset"], 0x10000)
            self.assertEqual(manifest["readback"]["address"], 0x20000)


if __name__ == "__main__":
    unittest.main()
