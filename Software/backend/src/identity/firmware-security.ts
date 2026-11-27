/** Inspect verified ESP-IDF artifacts from the existing catalog, which predates
 * explicit security metadata. These markers are compiled only into the matching
 * hardware-security paths in the project's pinned ESP-IDF toolchain. */
export function firmwareSecurityRequirements(app: Buffer, bootloader: Buffer) {
  return {
    flashEncryption: app.includes(Buffer.from("Flash encryption eFuse bit was not enabled in bootloader")) ||
      bootloader.includes(Buffer.from("flash_encrypt")),
    secureBoot: bootloader.includes(Buffer.from("secure_boot_v2")),
  };
}

export function firmwareMatchesBoardSecurity(app: Buffer, bootloader: Buffer, encrypted: boolean): boolean {
  const required = firmwareSecurityRequirements(app, bootloader);
  return required.flashEncryption === encrypted && required.secureBoot === encrypted;
}

/** USB flashing supports ordinary boards only. Older clients may omit the flag. */
export function usbFlashEncryptionEnabled(value: unknown): false {
  if (value !== undefined && typeof value !== "boolean") throw new Error("flashEncryptionEnabled must be a boolean");
  if (value === true) throw new Error("USB flasher only supports boards without Secure Boot/Flash Encryption");
  return false;
}
