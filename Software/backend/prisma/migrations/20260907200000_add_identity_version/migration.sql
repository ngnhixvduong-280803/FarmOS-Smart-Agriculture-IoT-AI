-- Factory firmware signs identity_version into the canonical BLE attestation
-- transcript. Keep this additive so restored databases remain migratable.
ALTER TABLE "device_identities"
  ADD COLUMN IF NOT EXISTS "identity_version" INTEGER NOT NULL DEFAULT 2;

-- Existing rows come from the compatibility inventory path. New QR v3
-- allocations set identity_version=3 explicitly after this migration.
UPDATE "device_identities"
SET "identity_version" = 2
WHERE "identity_version" IS NULL OR "identity_version" NOT IN (2, 3);

-- Make the compatibility path explicit instead of inferring v2 from a generic
-- INVENTORY row. QR-v3 allocation writes version 3 and never enters LEGACY.
UPDATE "device_identities"
SET "state" = 'LEGACY'
WHERE "identity_version" = 2 AND "state" = 'INVENTORY';
