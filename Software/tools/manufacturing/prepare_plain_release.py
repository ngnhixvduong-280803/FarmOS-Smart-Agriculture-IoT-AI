#!/usr/bin/env python3
"""Prepare a shared USB factory release without programming hardware security."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def validate_profile(config: str) -> None:
    enabled = {line.split("=", 1)[0] for line in config.splitlines() if line.endswith("=y")}
    required = {"CONFIG_FARMOS_FACTORY_PLAIN_FLASH", "CONFIG_SECURE_SIGNED_APPS", "CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT"}
    forbidden = {"CONFIG_FARMOS_DEVELOPMENT_IDENTITY", "CONFIG_NVS_ENCRYPTION", "CONFIG_SECURE_BOOT", "CONFIG_SECURE_FLASH_ENC_ENABLED"}
    if not required <= enabled or enabled & forbidden:
        raise ValueError("Build is not the plain factory profile with genuine enrollment and signed OTA")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, required=True)
    parser.add_argument("--sdkconfig", type=Path, required=True)
    parser.add_argument("--signing-key", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    prepare_release(args.build_dir, args.sdkconfig, args.signing_key, args.out)


def prepare_release(build_dir: Path, sdkconfig: Path, signing_key: Path, out: Path) -> None:
    validate_profile(sdkconfig.read_text())
    if signing_key.stat().st_mode & 0o077:
        raise ValueError("Signing key must be a private file")
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    app = out / "firmware.bin"
    for command in ("sign_data", "verify_signature"):
        options = [sys.executable, "-m", "espsecure", command, "--version", "2", "--keyfile", str(signing_key)]
        if command == "sign_data":
            options += ["--output", str(app), str(build_dir / "firmware.bin")]
        else:
            options += [str(app)]
        result = subprocess.run(options, capture_output=True)
        if result.returncode:
            raise RuntimeError(f"Offline application {command} failed")
    images = [("APP", 0x20000, app)]
    for role, offset, source, target in (
        ("BOOTLOADER", 0, "bootloader.bin", "bootloader.bin"),
        ("PARTITION_TABLE", 0x10000, "partitions.bin", "partitions.bin"),
        ("OTA_DATA", 0x19000, "ota_data_initial.bin", "ota_data_initial.bin"),
    ):
        destination = out / target
        destination.write_bytes((build_dir / source).read_bytes())
        images.append((role, offset, destination))
    boot = (out / "bootloader.bin").read_bytes()
    if b"flash_encrypt" in boot or b"secure_boot_v2" in boot or b"Flash encryption eFuse bit was not enabled in bootloader" in app.read_bytes():
        raise ValueError("Hardware security image detected; refusing plain release")
    records = [{"role": role, "address": offset, "fileName": file.name, "sizeBytes": file.stat().st_size,
                "sha256": hashlib.sha256(file.read_bytes()).hexdigest()} for role, offset, file in images]
    (out / "artifacts.json").write_text(json.dumps(records, indent=2))
    print("Verified plain factory image set and offline application signature")


if __name__ == "__main__":
    main()
