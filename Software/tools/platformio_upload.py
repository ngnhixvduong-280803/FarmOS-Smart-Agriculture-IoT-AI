"""Keep local PlatformIO builds separate from audited USB flashing."""
Import("env")

def upload(source, target, env):
    print("FarmOS: build with python tools/build_firmware.py; nạp USB bằng FarmOS Flasher để cấp ID/QR.")
    return 1

env.Replace(UPLOADCMD=upload, UPLOADERFLAGS=[])
