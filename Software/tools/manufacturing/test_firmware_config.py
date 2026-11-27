import importlib.util
import tempfile
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "tools" / "firmware_config.py"
SPEC = importlib.util.spec_from_file_location("farmos_firmware_config_test", MODULE_PATH)
assert SPEC and SPEC.loader
firmware_config = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(firmware_config)


PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZRAuSARvDAn4rF_AdTSh0fBtNgOzE4KyElL5h8Sb3-ZOgdloSiK1d-_0xnqgU5_LW8hJbjKHwcrnWj-xIP9nNg"


class FirmwareConfigTest(unittest.TestCase):
    def test_release_version_is_shared_by_both_app_descriptors(self):
        version = (ROOT / "firmware/VERSION").read_text().strip()
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")
        for role in ("node", "gateway"):
            project = ROOT / "firmware" / role
            self.assertIn('../VERSION', (project / "CMakeLists.txt").read_text())
            self.assertIn('esp_app_get_description()->version', (project / "include/board_config.h").read_text())
            self.assertEqual((project / "platformio.ini").read_text().count('[env:'), 1)

    def write_env(self, text: str) -> Path:
        handle = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8")
        with handle:
            handle.write(text)
        return Path(handle.name)

    def test_production_requires_public_p256_key(self):
        env = self.write_env("FARMOS_API_URL=https://api.example.test\n")
        with self.assertRaises(firmware_config.FirmwareConfigError):
            firmware_config.public_config_from_env(env, "production", environ={})

    def test_canonical_public_key_populates_firmware_overlay(self):
        env = self.write_env(
            f"FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY={PUBLIC_KEY}\n"
        )
        config = firmware_config.public_config_from_env(env, "production", environ={})
        self.assertEqual(config[firmware_config.PUBLIC_KEY_ENV], PUBLIC_KEY)

    def test_public_key_alias_must_match_canonical_public_key(self):
        alternate = PUBLIC_KEY[:-1] + ("A" if PUBLIC_KEY[-1] != "A" else "B")
        env = self.write_env(
            f"FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY={PUBLIC_KEY}\n"
            f"FIRMWARE_ENROLLMENT_SERVER_PUBLIC_KEY={alternate}\n"
        )
        with self.assertRaises(firmware_config.FirmwareConfigError):
            firmware_config.public_config_from_env(env, "production", environ={})

    def test_production_rejects_malformed_or_wrong_curve_key(self):
        env = self.write_env("FIRMWARE_ENROLLMENT_SERVER_PUBLIC_KEY=not-a-key\n")
        with self.assertRaises(firmware_config.FirmwareConfigError):
            firmware_config.public_config_from_env(env, "production", environ={})
        with self.assertRaises(firmware_config.FirmwareConfigError):
            firmware_config.validate_p256_spki_base64url("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQc")

    def test_dev_allows_explicit_empty_key(self):
        env = self.write_env('FIRMWARE_ENROLLMENT_SERVER_PUBLIC_KEY=""\n')
        config = firmware_config.public_config_from_env(env, "dev", environ={})
        self.assertEqual(config[firmware_config.PUBLIC_KEY_ENV], "")

    def test_process_environment_overrides_dotenv_without_private_material(self):
        env = self.write_env(
            "FIRMWARE_ENROLLMENT_SERVER_PUBLIC_KEY=stale\n"
            "FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY=do-not-copy\n"
            "FARMOS_API_URL=https://secret.example.test\n"
        )
        parsed = firmware_config.parse_dotenv(env)
        self.assertNotIn("FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY", parsed)
        config = firmware_config.public_config_from_env(env, "production", environ={firmware_config.PUBLIC_KEY_ENV: PUBLIC_KEY})
        self.assertEqual(config[firmware_config.PUBLIC_KEY_ENV], PUBLIC_KEY)
        rendered = firmware_config.render_sdkconfig_overlay(config, "production")
        self.assertIn(PUBLIC_KEY, rendered)
        self.assertNotIn("FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY", rendered)
        self.assertNotIn("FARMOS_API_URL", rendered)
        self.assertNotIn("secret.example.test", rendered)

    def test_generated_overlay_rejects_stale_output(self):
        env = self.write_env(f"FIRMWARE_ENROLLMENT_SERVER_PUBLIC_KEY={PUBLIC_KEY}\n")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "sdkconfig.defaults"
            firmware_config.generate_overlay(env, output, "production", environ={})
            config = firmware_config.public_config_from_env(env, "production", environ={})
            firmware_config.validate_generated_overlay(output, config, "production")
            output.write_text(output.read_text(encoding="utf-8").replace(PUBLIC_KEY, "stale"), encoding="utf-8")
            with self.assertRaises(firmware_config.FirmwareConfigError):
                firmware_config.validate_generated_overlay(output, config, "production")

    def test_platformio_sdkconfig_replaces_persisted_empty_key(self):
        config = {firmware_config.PUBLIC_KEY_ENV: PUBLIC_KEY}
        with tempfile.TemporaryDirectory() as directory:
            sdkconfig = Path(directory) / "sdkconfig.node"
            sdkconfig.write_text(
                'CONFIG_OTHER_OPTION=y\nCONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY=""\n',
                encoding="utf-8",
            )
            firmware_config.sync_platformio_sdkconfig(sdkconfig, config, "dev")
            text = sdkconfig.read_text(encoding="utf-8")
            self.assertIn("CONFIG_OTHER_OPTION=y", text)
            self.assertIn(
                f'CONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY="{PUBLIC_KEY}"', text
            )
            self.assertEqual(text.count("CONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY="), 1)

    def test_compiled_artifact_must_contain_configured_public_key(self):
        config = {firmware_config.PUBLIC_KEY_ENV: PUBLIC_KEY}
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "firmware.bin"
            artifact.write_bytes(b"prefix" + PUBLIC_KEY.encode("ascii") + b"suffix")
            firmware_config.validate_firmware_artifact(artifact, config, "production")
            artifact.write_bytes(b"firmware-without-trust-anchor")
            with self.assertRaises(firmware_config.FirmwareConfigError):
                firmware_config.validate_firmware_artifact(artifact, config, "production")


if __name__ == "__main__":
    unittest.main()
