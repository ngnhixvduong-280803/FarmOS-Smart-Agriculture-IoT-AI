#!/usr/bin/env python3
"""Build and validate FarmOS ESP32-S3 release artifact manifests.

The PlatformIO application artifact is only one part of a safe factory image.
This tool reads the generated bootloader, partition table, OTA selector and app
artifacts, verifies their authoritative addresses against ``firmware/flash_layout.json``,
hashes every byte, and emits metadata suitable for the backend release manifest.

Normal Web Serial REFLASH is deliberately represented as an APP-only write at
the OTA_0 address. The full four-image set remains available for manufacturing;
neither set is allowed to overlap ``factory_cfg`` (factory_identity) or
``nvs_keys``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[2]
LAYOUT_PATH = ROOT / "firmware" / "flash_layout.json"
FLASH_SIZE = 0x1000000


class FirmwareManifestError(ValueError):
    """Raised when a build artifact cannot be safely released."""


def load_layout(path: Path = LAYOUT_PATH) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FirmwareManifestError(f"cannot read layout {path}: {error}") from error
    if not isinstance(value, dict):
        raise FirmwareManifestError("flash layout must be a JSON object")
    validate_layout(value)
    return value


def _interval(item: dict[str, Any]) -> tuple[int, int]:
    try:
        start = int(item["offset"])
        size = int(item.get("sizeBytes", item.get("reservedSizeBytes")))
    except (KeyError, TypeError, ValueError) as error:
        raise FirmwareManifestError(f"invalid range: {item!r}") from error
    if start < 0 or size <= 0:
        raise FirmwareManifestError(f"invalid range bounds: {item!r}")
    return start, start + size


def _overlaps(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return left[0] < right[1] and right[0] < left[1]


def _assert_non_overlapping(items: Iterable[dict[str, Any]], label: str) -> None:
    ranges = sorted((_interval(item), str(item.get("name", index))) for index, item in enumerate(items))
    for (left_range, left_name), (right_range, right_name) in zip(ranges, ranges[1:]):
        if _overlaps(left_range, right_range):
            raise FirmwareManifestError(f"{label} overlap: {left_name} and {right_name}")


def _partition_map(layout: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item["name"]): item for item in layout.get("partitions", [])}


def validate_layout(layout: dict[str, Any]) -> None:
    """Validate bounds, partition overlaps and immutable protected ranges."""
    flash_size = int(layout.get("flashSizeBytes", 0))
    if flash_size != FLASH_SIZE:
        raise FirmwareManifestError(f"FarmOS ESP32-S3 layout must describe 16 MiB, got {flash_size}")
    targets = layout.get("targets")
    if not isinstance(targets, dict) or set(targets) != {"NODE", "GATEWAY"}:
        raise FirmwareManifestError("layout must define authoritative NODE and GATEWAY targets")
    for target_name, target in targets.items():
        if not isinstance(target, dict) or not target.get("deviceType") or not target.get("firmwareTarget") or not target.get("project") or not target.get("partitionCsv"):
            raise FirmwareManifestError(f"layout target {target_name} is incomplete")
    partition_table = layout.get("partitionTable")
    bootloader = layout.get("bootloaderRegion")
    if not isinstance(partition_table, dict) or not isinstance(bootloader, dict):
        raise FirmwareManifestError("layout is missing partitionTable or bootloaderRegion")
    table_range = _interval({"offset": partition_table.get("offset"), "sizeBytes": partition_table.get("reservedSizeBytes")})
    boot_range = _interval({"offset": bootloader.get("offset"), "sizeBytes": bootloader.get("reservedSizeBytes")})
    if _overlaps(table_range, boot_range):
        raise FirmwareManifestError("bootloader reservation overlaps partition-table reservation")
    if table_range[1] > flash_size or boot_range[1] > flash_size:
        raise FirmwareManifestError("bootloader or partition-table reservation exceeds flash")

    partitions = layout.get("partitions")
    if not isinstance(partitions, list) or not partitions:
        raise FirmwareManifestError("layout has no partitions")
    _assert_non_overlapping(partitions, "partition")
    partition_map = _partition_map(layout)
    for name, item in partition_map.items():
        start, end = _interval(item)
        if end > flash_size:
            raise FirmwareManifestError(f"partition {name} exceeds flash")
        if _overlaps((0, table_range[1]), (start, end)):
            raise FirmwareManifestError(f"partition {name} overlaps bootloader/partition-table reserved area")
    protected = layout.get("protectedRanges")
    if not isinstance(protected, list) or not protected:
        raise FirmwareManifestError("layout has no protectedRanges")
    _assert_non_overlapping(protected, "protected range")
    for item in protected:
        start, end = _interval(item)
        if end > flash_size:
            raise FirmwareManifestError(f"protected range {item.get('name')} exceeds flash")
        partition = partition_map.get(str(item.get("partition")))
        if partition is None or _interval(partition) != (start, end):
            raise FirmwareManifestError(f"protected range {item.get('name')} is not an exact partition range")
    for item in protected:
        if str(item.get("partition")) not in {"factory_cfg", "nvs_keys"}:
            raise FirmwareManifestError(f"unexpected protected partition {item.get('partition')}")

    artifacts = layout.get("artifacts")
    if not isinstance(artifacts, dict):
        raise FirmwareManifestError("layout has no artifacts mapping")
    expected = {"bootloader", "partitions", "otaData", "application"}
    if set(artifacts) != expected:
        raise FirmwareManifestError(f"layout artifacts must be {sorted(expected)}")
    if int(artifacts["bootloader"]["offset"]) != int(bootloader["offset"]):
        raise FirmwareManifestError("bootloader artifact offset does not match reservation")
    if int(artifacts["partitions"]["offset"]) != int(partition_table["offset"]):
        raise FirmwareManifestError("partition-table artifact offset does not match reservation")
    app_offset = int(artifacts["application"]["offset"])
    app_partitions = [item for item in partitions if item.get("role") == "APP"]
    if not any(int(item["offset"]) == app_offset for item in app_partitions):
        raise FirmwareManifestError("application artifact is not at an APP partition offset")
    reflash = layout.get("normalReflash")
    if not isinstance(reflash, dict) or reflash.get("writableRoles") != ["APP", "OTA_DATA"]:
        raise FirmwareManifestError("normalReflash must allow APP then OTA_DATA writes")
    if reflash.get("readbackRole") != "APP" or reflash.get("readbackPartition") != "ota_0":
        raise FirmwareManifestError("normalReflash readback must target APP partition ota_0")
    if reflash.get("writePlan") != "NORMAL_REFLASH":
        raise FirmwareManifestError("normalReflash must reference the NORMAL_REFLASH write plan")
    for item in protected:
        if item["name"] not in reflash.get("protectedRanges", []):
            raise FirmwareManifestError(f"normalReflash omits protected range {item['name']}")

    plans = layout.get("writePlans")
    if not isinstance(plans, dict):
        raise FirmwareManifestError("layout has no writePlans")
    plan_roles = {
        "NORMAL_REFLASH": ["APP", "OTA_DATA"],
        "FACTORY_FULL_FLASH": ["BOOTLOADER", "PARTITION_TABLE", "APP", "OTA_DATA"],
    }
    artifact_roles = {key: str(value.get("role")) for key, value in artifacts.items()}
    artifact_offsets = {key: int(value.get("offset")) for key, value in artifacts.items()}
    for plan_name, expected_roles in plan_roles.items():
        plan = plans.get(plan_name)
        if not isinstance(plan, list) or any(not isinstance(item, dict) for item in plan) or [str(item.get("role")) for item in plan] != expected_roles:
            raise FirmwareManifestError(f"{plan_name} write plan must order {expected_roles}")
        orders: list[int] = []
        for item, expected_role in zip(plan, expected_roles):
            artifact = str(item.get("artifact"))
            if artifact not in artifact_roles or artifact_roles[artifact] != expected_role:
                raise FirmwareManifestError(f"{plan_name} step does not match its artifact role")
            try:
                address = int(item.get("address", -1))
                order = int(item.get("order", -1))
            except (TypeError, ValueError) as error:
                raise FirmwareManifestError(f"{plan_name} step has invalid address/order") from error
            if address != artifact_offsets[artifact]:
                raise FirmwareManifestError(f"{plan_name} step address does not match its artifact")
            if order <= 0 or (orders and order <= orders[-1]):
                raise FirmwareManifestError(f"{plan_name} steps must have strictly increasing order")
            orders.append(order)
        if str(plan[-1].get("phase")) != "COMMIT_OTA0_LAST" or str(plan[-1].get("selector")) != "ota_0":
            raise FirmwareManifestError(f"{plan_name} must commit ota_0 with OTA_DATA last")


def parse_int(value: str) -> int:
    value = value.strip()
    return int(value, 16) if value.lower().startswith("0x") else int(value, 10)


def parse_partition_csv(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise FirmwareManifestError(f"cannot read partition CSV {path}: {error}") from error
    reader = csv.reader(line for line in lines if line.strip() and not line.lstrip().startswith("#"))
    for raw in reader:
        if len(raw) < 5:
            raise FirmwareManifestError(f"partition row has too few fields: {raw!r}")
        name, kind, subtype, offset, size = (part.strip() for part in raw[:5])
        flags = [part.strip() for part in raw[5:] if part.strip()]
        rows.append({"name": name, "type": kind, "subtype": subtype,
                     "offset": parse_int(offset), "sizeBytes": parse_int(size),
                     "flags": flags})
    if not rows:
        raise FirmwareManifestError(f"partition CSV {path} is empty")
    return rows


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise FirmwareManifestError(f"cannot hash artifact {path}: {error}") from error
    return digest.hexdigest()


def _artifact(path: Path, role: str, partition: str, address: int, required_for: str) -> dict[str, Any]:
    try:
        size = path.stat().st_size
    except OSError as error:
        raise FirmwareManifestError(f"artifact is missing: {path}") from error
    if size <= 0:
        raise FirmwareManifestError(f"artifact is empty: {path}")
    return {
        "id": f"{role.lower()}-{path.name}",
        "name": path.name,
        "fileName": path.name,
        "role": role,
        "partition": partition,
        "address": address,
        "sizeBytes": size,
        "sha256": _sha256(path),
        "required": True,
        "requiredFor": required_for,
    }


def _resolve(path: Path, *candidates: str | None) -> Path:
    for candidate in candidates:
        if candidate:
            resolved = path / candidate
            if resolved.is_file():
                return resolved
    raise FirmwareManifestError(f"none of the build artifact candidates exist: {candidates!r}")


def _build_files(build_dir: Path) -> dict[str, Path]:
    flasher_path = build_dir / "flasher_args.json"
    try:
        flasher = json.loads(flasher_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FirmwareManifestError(f"cannot read {flasher_path}: {error}") from error
    def declared(key: str) -> str | None:
        value = flasher.get(key)
        return str(value.get("file")) if isinstance(value, dict) and value.get("file") else None
    files = {
        "bootloader": _resolve(build_dir, "bootloader.bin", declared("bootloader")),
        "partitions": _resolve(build_dir, "partitions.bin", declared("partition-table")),
        "otaData": _resolve(build_dir, "ota_data_initial.bin", declared("otadata")),
        "application": _resolve(build_dir, "firmware.bin", declared("app")),
    }
    return files


def _verify_partitions(project_dir: Path, layout: dict[str, Any], partition_csv: str = "partitions.csv") -> None:
    source = parse_partition_csv(project_dir / partition_csv)
    expected = {item["name"]: item for item in layout["partitions"]}
    actual = {item["name"]: item for item in source}
    if set(actual) != set(expected):
        raise FirmwareManifestError(f"partition CSV names differ from authoritative layout: {sorted(actual)}")
    for name, expected_item in expected.items():
        got = actual[name]
        if (got["offset"], got["sizeBytes"]) != (int(expected_item["offset"]), int(expected_item["sizeBytes"])):
            raise FirmwareManifestError(f"partition {name} differs from authoritative layout")
    _assert_non_overlapping(source, "partition CSV")


def manifest_for_build(build_dir: Path, role: str, profile: str,
                       layout_path: Path = LAYOUT_PATH,
                       merged_output: Path | None = None) -> dict[str, Any]:
    """Create a hash/address manifest from one completed PlatformIO build."""
    role = role.strip().upper()
    profile = profile.strip().lower()
    if role not in {"NODE", "GATEWAY"}:
        raise FirmwareManifestError("role must be NODE or GATEWAY")
    layout = load_layout(layout_path)
    if profile not in layout["profiles"]:
        raise FirmwareManifestError(f"unknown build profile {profile}")
    build_dir = build_dir.resolve()
    # PlatformIO uses ``<project>/.pio/build/<environment>``.  ``parent`` is
    # ``build`` and ``parent.parent`` is ``.pio``; the partition CSV lives at
    # the project root, one level further up.
    project_dir = build_dir.parents[2]
    if project_dir.name != str(layout["targets"][role]["project"]):
        raise FirmwareManifestError(
            f"build project {project_dir.name!r} does not match {role} target project"
        )
    _verify_partitions(project_dir, layout, str(layout["targets"][role]["partitionCsv"]))
    files = _build_files(build_dir)
    artifact_offsets = {key: int(value["offset"]) for key, value in layout["artifacts"].items()}
    roles = {"bootloader": "BOOTLOADER", "partitions": "PARTITION_TABLE", "otaData": "OTA_DATA", "application": "APP"}
    partitions = {"bootloader": "bootloader", "partitions": "partition_table", "otaData": "ota_data", "application": "ota_0"}
    required_for = {
        "bootloader": "FACTORY_FULL_FLASH",
        "partitions": "FACTORY_FULL_FLASH",
        "otaData": "FACTORY_FULL_FLASH_AND_NORMAL_REFLASH",
        "application": "WEB_SERIAL_REFLASH_AND_OTA",
    }
    artifacts = [_artifact(files[key], roles[key], partitions[key], artifact_offsets[key], required_for[key]) for key in ("bootloader", "partitions", "otaData", "application")]
    artifacts_by_key = {key: item for key, item in zip(("bootloader", "partitions", "otaData", "application"), artifacts)}
    partition_map = _partition_map(layout)
    for item in artifacts:
        artifact_range = (item["address"], item["address"] + item["sizeBytes"])
        if item["role"] == "BOOTLOADER" and artifact_range[1] > int(layout["bootloaderRegion"]["offset"]) + int(layout["bootloaderRegion"]["reservedSizeBytes"]):
            raise FirmwareManifestError("bootloader artifact exceeds reserved bootloader region")
        if item["role"] == "PARTITION_TABLE" and item["sizeBytes"] > int(layout["partitionTable"]["reservedSizeBytes"]):
            raise FirmwareManifestError("partition-table artifact exceeds reserved partition-table region")
        if item["role"] == "OTA_DATA" and item["sizeBytes"] > int(partition_map["otadata"]["sizeBytes"]):
            raise FirmwareManifestError("ota_data artifact exceeds otadata partition")
        if item["role"] == "APP":
            app = partition_map["ota_0"]
            if item["address"] != int(app["offset"]) or item["sizeBytes"] > int(app["sizeBytes"]):
                raise FirmwareManifestError("application artifact does not fit ota_0")
        for protected in layout["protectedRanges"]:
            protected_range = (int(protected["offset"]), int(protected["offset"]) + int(protected["sizeBytes"]))
            if _overlaps(artifact_range, protected_range):
                raise FirmwareManifestError(f"artifact {item['name']} overlaps protected {protected['name']}")

    merged: dict[str, Any] | None = None
    if merged_output is not None:
        merged_output = merged_output.resolve()
        _write_merged_image(artifacts, files, merged_output, int(layout["flashSizeBytes"]))
        merged = _artifact(merged_output, "MERGED_IMAGE", "merged", 0, "FACTORY_FULL_FLASH")
        merged["id"] = "merged-image"

    def manifest_plan(name: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for step in layout["writePlans"][name]:
            artifact = artifacts_by_key[str(step["artifact"])]
            item = dict(step)
            item.pop("artifact", None)
            item["imageId"] = artifact["id"]
            item["fileName"] = artifact["fileName"]
            item["sizeBytes"] = artifact["sizeBytes"]
            item["sha256"] = artifact["sha256"]
            result.append(item)
        return result

    write_plans = {name: manifest_plan(name) for name in ("NORMAL_REFLASH", "FACTORY_FULL_FLASH")}
    application = artifacts_by_key["application"]
    # Keep the serialized image order safe for consumers that do not yet
    # understand writePlans: the OTA selector is committed after the APP.
    # Addresses remain authoritative and the signed write plans carry the
    # explicit phase/verification semantics for clients that do understand it.
    manifest_images = [artifacts_by_key[key] for key in ("bootloader", "partitions", "application", "otaData")]

    target = layout["targets"][role]
    device_type = str(target["deviceType"])
    firmware_target = str(target["firmwareTarget"])
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "layoutId": layout["layoutId"],
        "board": layout["board"],
        "chipFamily": layout["chipFamily"],
        "profile": profile,
        "deviceType": device_type,
        "firmwareTarget": firmware_target,
        "partitionScheme": layout["layoutId"],
        "flashSizeBytes": layout["flashSizeBytes"],
        "partitionTableOffset": layout["partitionTable"]["offset"],
        "protectedRanges": layout["protectedRanges"],
        "images": manifest_images,
        "writePlans": write_plans,
        "normalReflash": {
            "writableRoles": layout["normalReflash"]["writableRoles"],
            "readbackRole": layout["normalReflash"]["readbackRole"],
            "readbackPartition": layout["normalReflash"]["readbackPartition"],
            "readbackOffset": layout["normalReflash"]["readbackOffset"],
            "readbackLength": application["sizeBytes"],
            "images": [step["imageId"] for step in write_plans["NORMAL_REFLASH"]],
            "writePlan": layout["normalReflash"]["writePlan"],
        },
        "readback": {
            "role": "APP",
            "partition": layout["normalReflash"]["readbackPartition"],
            "address": application["address"],
            "length": application["sizeBytes"],
            "sha256": application["sha256"],
        },
        "security": layout["profiles"][profile],
    }
    if merged is not None:
        manifest["mergedImage"] = merged
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    manifest["buildManifestSha256"] = hashlib.sha256(canonical).hexdigest()
    return manifest


def _write_merged_image(artifacts: list[dict[str, Any]], files: dict[str, Path], output: Path, flash_size: int) -> None:
    end = max(item["address"] + item["sizeBytes"] for item in artifacts)
    if end > flash_size:
        raise FirmwareManifestError("merged image exceeds flash size")
    output.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(prefix=f"{output.name}.", dir=output.parent, delete=False) as temporary:
        temporary.truncate(end)
        temporary.flush()
        temporary_path = Path(temporary.name)
    try:
        with temporary_path.open("r+b") as handle:
            handle.write(b"\xff" * end)
            for key, item in zip(("bootloader", "partitions", "otaData", "application"), artifacts):
                handle.seek(item["address"])
                handle.write(files[key].read_bytes())
        temporary_path.replace(output)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, required=True, help="PlatformIO .pio/build/<environment> directory")
    parser.add_argument("--role", choices=("NODE", "GATEWAY"), required=True)
    parser.add_argument("--profile", choices=("usb",), default="usb")
    parser.add_argument("--layout", type=Path, default=LAYOUT_PATH)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--merged-output", type=Path)
    args = parser.parse_args()
    try:
        manifest = manifest_for_build(args.build_dir, args.role, args.profile, args.layout, args.merged_output)
        output = (args.output or args.build_dir / "farmos-build-manifest.json").resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except FirmwareManifestError as error:
        parser.error(str(error))
    print(json.dumps({"manifest": str(output), "buildManifestSha256": manifest["buildManifestSha256"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
