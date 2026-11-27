import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_firmware import signing_key_from_env


class SigningConfigurationTests(unittest.TestCase):
    def test_key_reference_resolves_relative_to_env_without_reading_key_material(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            key = root / "signing.pem"
            key.write_text("private-material-must-not-be-read-by-config")
            key.chmod(0o600)
            env = root / ".env"
            env.write_text('FARMOS_FIRMWARE_SIGNING_KEY_FILE="signing.pem"\nJWT_SECRET=unrelated\n')
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(signing_key_from_env(env), key)
                key.chmod(0o644)
                with self.assertRaises(ValueError):
                    signing_key_from_env(env)

    def test_existing_key_alias_remains_usable_and_canonical_name_wins(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            key = root / "existing.pem"; key.touch(mode=0o600)
            env = root / ".env"
            env.write_text("FARMOS_SECURE_BOOT_SIGNING_KEY_FILE=existing.pem\n")
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(signing_key_from_env(env), key)
            with patch.dict(os.environ, {"FARMOS_FIRMWARE_SIGNING_KEY_FILE": "missing.pem"}, clear=True):
                with self.assertRaises(ValueError):
                    signing_key_from_env(env)


if __name__ == "__main__":
    unittest.main()
