#!/usr/bin/env python3
"""Build and sign the ordinary Node/Gateway release; never writes a board."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from firmware_config import public_config_from_env, validate_firmware_artifact
from manufacturing.prepare_plain_release import prepare_release

ROOT = Path(__file__).resolve().parents[1]


def signing_key_from_env(env_file: Path) -> Path:
    names = ("FARMOS_FIRMWARE_SIGNING_KEY_FILE", "FARMOS_SECURE_BOOT_SIGNING_KEY_FILE")
    values = {}
    for line in env_file.read_text().splitlines():
        match = re.match(r"(?:export\s+)?([A-Z_]+)\s*=\s*(.*)", line.strip())
        if match and match[1] in names:
            value = match[2].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[match[1]] = value
    for name in names:
        if name in os.environ:
            values[name] = os.environ[name]
    value = next((values[name] for name in names if values.get(name)), "")
    if not value:
        raise ValueError("Set FARMOS_FIRMWARE_SIGNING_KEY_FILE to the existing offline signing key")
    key = Path(value).expanduser()
    if not key.is_absolute():
        key = env_file.parent / key
    if not key.is_file() or key.is_symlink() or key.stat().st_mode & 0o077:
        raise ValueError("Signing key must be a private regular file (chmod 600)")
    return key


def platformio_command() -> list[str]:
    executable = shutil.which("pio")
    if executable:
        return [executable]
    bundled = Path.home() / ".platformio/penv/bin/platformio"
    if bundled.is_file():
        return [str(bundled)]
    raise ValueError("PlatformIO is missing; install it with python -m pip install platformio")


def build(device: str, env_file: Path, output: Path, key: Path) -> Path:
    version = (ROOT / "firmware/VERSION").read_text().strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("firmware/VERSION must be x.y.z")
    destination = output / device / version
    if destination.exists():
        raise ValueError(f"Release output already exists: {destination}; choose a new --out directory")
    config = public_config_from_env(env_file, "production")
    project = ROOT / "firmware" / device
    build_dir = project / ".pio/build" / device
    # The hook sees only public release configuration; private key material is
    # consumed by the offline signing step after compilation.
    subprocess.run([*platformio_command(), "run", "-d", str(project), "-e", device],
                   env={**os.environ, "FARMOS_ENV_FILE": str(env_file)}, check=True)
    validate_firmware_artifact(build_dir / "firmware.bin", config, "production")
    app = (build_dir / "firmware.bin").read_bytes()
    if app[48:80].split(b"\0", 1)[0].decode("ascii") != version:
        raise ValueError("Compiled application version does not match firmware/VERSION")
    if app[80:112].split(b"\0", 1)[0].decode("ascii") != f"farmos_{device}":
        raise ValueError("Compiled application targets a different device")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Publish the output directory only after every signature/profile check
    # passes. A failed build leaves no apparently usable release folder.
    with tempfile.TemporaryDirectory(prefix=".release-", dir=destination.parent) as temporary:
        stage = Path(temporary) / "bundle"
        prepare_release(build_dir, project / f"sdkconfig.{device}", key, stage)
        (stage / "release.json").write_text(json.dumps({
            "version": version, "device": device, "profile": "usb",
            "firmwareTarget": "ESP32S3_LORA_GATEWAY_V1" if device == "gateway" else "ESP32S3_LORA_SENSOR_V1",
            "factoryFiles": ["firmware.bin", "bootloader.bin", "partitions.bin", "ota_data_initial.bin"],
            "otaFile": "firmware.bin",
        }, indent=2) + "\n")
        stage.rename(destination)
    print(f"Ready: {destination}")
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=["node", "gateway", "all"], default="all")
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    parser.add_argument("--out", type=Path, default=ROOT / "dist/firmware")
    args = parser.parse_args()
    try:
        if importlib.util.find_spec("espsecure") is None:
            raise ValueError("Install build dependencies: python -m pip install -r tools/firmware-requirements.txt")
        env_file = args.env_file.expanduser().resolve()
        key = signing_key_from_env(env_file)
        for device in ["node", "gateway"] if args.device == "all" else [args.device]:
            build(device, env_file, args.out.expanduser().resolve(), key)
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        # Never print private key bytes or provider tokens.
        print(f"Firmware build stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
