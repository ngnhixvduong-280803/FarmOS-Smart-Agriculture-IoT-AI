"""PlatformIO pre-build hook for the root public firmware config contract."""

from __future__ import annotations

import importlib.util
import json
import os
import re
from pathlib import Path


Import("env")  # type: ignore[name-defined]  # provided by PlatformIO/SCons

project_dir = Path(env.subst("$PROJECT_DIR")).resolve()  # type: ignore[name-defined]
repository_root = project_dir.parent.parent
profile = "production"
firmware_version = (project_dir.parent / "VERSION").read_text(encoding="utf-8").splitlines()[0].strip()
build_dir = Path(env.subst("$BUILD_DIR"))  # type: ignore[name-defined]
description = build_dir / "project_description.json"

# PlatformIO checks timestamps inside the project, while VERSION is shared
# by all three firmware projects. Force a CMake configure on a version change.
if description.is_file():
    cached_version = json.loads(description.read_text(encoding="utf-8")).get("project_version")
    if cached_version != firmware_version:
        (build_dir / "CMakeCache.txt").unlink(missing_ok=True)
env_file = Path(os.environ.get("FARMOS_ENV_FILE", str(repository_root / ".env"))).expanduser().resolve()
output = project_dir / ".pio" / "firmware-config" / profile / "sdkconfig.defaults"

module_path = repository_root / "tools" / "firmware_config.py"
spec = importlib.util.spec_from_file_location("farmos_firmware_config", module_path)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load firmware config generator: {module_path}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

try:
    config = module.public_config_from_env(env_file, profile)
    module.generate_overlay(env_file, output, profile)
    sdkconfig = project_dir / f"sdkconfig.{env.get('PIOENV', '')}"
    module.sync_platformio_sdkconfig(sdkconfig, config, profile)
    # Defaults do not replace persisted menuconfig values. Pin the single USB
    # profile even when this directory previously built a development image.
    previous = sdkconfig.read_text()
    current = previous
    controlled = {"CONFIG_FARMOS_FACTORY_PLAIN_FLASH", "CONFIG_FARMOS_DEVELOPMENT_IDENTITY",
                  "CONFIG_NVS_ENCRYPTION", "CONFIG_SECURE_BOOT", "CONFIG_SECURE_FLASH_ENC_ENABLED",
                  "CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT", "CONFIG_SECURE_SIGNED_APPS_RSA_SCHEME",
                  "CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT", "CONFIG_SECURE_BOOT_BUILD_SIGNED_BINARIES"}
    for line in (project_dir / "sdkconfig.defaults").read_text().splitlines():
        match = re.match(r"(?:# )?(CONFIG_[A-Z0-9_]+)(?:=| is not set)", line)
        if match and match.group(1) in controlled:
            name = match.group(1)
            pattern = rf"(?m)^(?:# )?{name}(?:=.*| is not set)$"
            if re.search(pattern, current):
                current = re.sub(pattern, line, current)
            else:
                current += line + "\n"
    if current != previous:
        sdkconfig.write_text(current)

except module.FirmwareConfigError as error:
    raise RuntimeError(f"FarmOS firmware {profile} config rejected: {error}") from error

def validate_artifact(source, target, env):
    artifact = Path(str(target[0]))
    try:
        module.validate_firmware_artifact(artifact, config, profile)
        with artifact.open("rb") as image:
            header = image.read(80)
        if header[32:36] != bytes.fromhex("3254cdab") or header[48:80].split(b"\0", 1)[0] != firmware_version.encode("ascii"):
            raise module.FirmwareConfigError("compiled ESP app descriptor version does not match firmware/VERSION")
    except module.FirmwareConfigError as error:
        raise RuntimeError(f"FarmOS firmware {profile} artifact rejected: {error}") from error


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", validate_artifact)  # type: ignore[name-defined]

print(f"FarmOS firmware config: {profile} enrollment trust anchor synchronized at {sdkconfig}")
