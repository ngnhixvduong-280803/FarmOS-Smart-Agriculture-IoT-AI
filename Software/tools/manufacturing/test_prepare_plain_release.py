import unittest
from prepare_plain_release import validate_profile


class PlainReleaseTests(unittest.TestCase):
    def test_requires_real_identity_and_signed_ota_without_fuse_configuration(self):
        profile = "CONFIG_FARMOS_FACTORY_PLAIN_FLASH=y\nCONFIG_SECURE_SIGNED_APPS=y\nCONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT=y\n"
        validate_profile(profile)
        for flag in ("CONFIG_FARMOS_DEVELOPMENT_IDENTITY", "CONFIG_NVS_ENCRYPTION", "CONFIG_SECURE_BOOT", "CONFIG_SECURE_FLASH_ENC_ENABLED"):
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                validate_profile(profile + flag + "=y\n")
        with self.assertRaises(ValueError):
            validate_profile(profile.replace("CONFIG_SECURE_SIGNED_APPS=y\n", ""))


if __name__ == "__main__":
    unittest.main()
