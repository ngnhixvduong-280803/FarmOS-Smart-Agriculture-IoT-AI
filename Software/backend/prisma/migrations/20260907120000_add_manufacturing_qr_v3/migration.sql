-- Manufacturing identity, signed QR v3 and possession-attested claim sessions.
-- The migration is deliberately additive and safe to apply after the restored
-- baseline plus the earlier onboarding migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeviceIdentityState') THEN
    CREATE TYPE "DeviceIdentityState" AS ENUM (
      'INVENTORY', 'LEGACY', 'ALLOCATED', 'FACTORY_WRITTEN', 'VERIFIED',
      'QC_PASSED', 'READY_TO_SHIP', 'CLAIMED', 'QUARANTINED', 'REVOKED'
    );
  ELSE
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'INVENTORY';
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'LEGACY';
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'CLAIMED';
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'REVOKED';
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'ALLOCATED';
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'FACTORY_WRITTEN';
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'VERIFIED';
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'QC_PASSED';
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'READY_TO_SHIP';
    ALTER TYPE "DeviceIdentityState" ADD VALUE IF NOT EXISTS 'QUARANTINED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ManufacturingBatchStatus') THEN
    CREATE TYPE "ManufacturingBatchStatus" AS ENUM (
      'DRAFT', 'OPEN', 'IN_PROGRESS', 'COMPLETE', 'QC_PASSED', 'READY_TO_SHIP',
      'QUARANTINED', 'CANCELLED'
    );
  ELSE
    ALTER TYPE "ManufacturingBatchStatus" ADD VALUE IF NOT EXISTS 'QC_PASSED';
    ALTER TYPE "ManufacturingBatchStatus" ADD VALUE IF NOT EXISTS 'READY_TO_SHIP';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeviceQrLabelState') THEN
    CREATE TYPE "DeviceQrLabelState" AS ENUM (
      'ISSUED', 'PRINTED', 'REPRINTED', 'QUARANTINED', 'REVOKED'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeviceLifecycleEventType') THEN
    CREATE TYPE "DeviceLifecycleEventType" AS ENUM (
      'IDENTITY_ALLOCATED', 'FACTORY_WRITTEN', 'FACTORY_READBACK_VERIFIED',
      'QR_ISSUED', 'QR_PRINT_CONFIRMED', 'QR_REPRINTED', 'QR_QUARANTINED',
      'QR_REVOKED', 'DEVICE_QUARANTINED', 'CLAIM_CHALLENGE_ISSUED',
      'CLAIM_ATTESTED', 'CLAIM_FINALIZED', 'LEGACY_PROVISIONED', 'QC_PASSED',
      'READY_TO_SHIP', 'DEVICE_RELEASED'
    );
  ELSE
    ALTER TYPE "DeviceLifecycleEventType" ADD VALUE IF NOT EXISTS 'QC_PASSED';
    ALTER TYPE "DeviceLifecycleEventType" ADD VALUE IF NOT EXISTS 'READY_TO_SHIP';
    ALTER TYPE "DeviceLifecycleEventType" ADD VALUE IF NOT EXISTS 'DEVICE_RELEASED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeviceClaimSessionStatus') THEN
    CREATE TYPE "DeviceClaimSessionStatus" AS ENUM (
      'CHALLENGE_ISSUED', 'ATTESTED', 'FINALIZED', 'EXPIRED', 'CANCELLED', 'FAILED'
    );
  END IF;
END $$;

ALTER TABLE "device_identities"
  ADD COLUMN IF NOT EXISTS "batch_id" TEXT,
  ADD COLUMN IF NOT EXISTS "public_key" TEXT,
  ADD COLUMN IF NOT EXISTS "public_key_algorithm" TEXT,
  ADD COLUMN IF NOT EXISTS "public_key_fingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "factory_cfg_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "factory_firmware_sha256" TEXT,
  ADD COLUMN IF NOT EXISTS "factory_station_id" TEXT,
  ADD COLUMN IF NOT EXISTS "factory_readback_proof" TEXT,
  ADD COLUMN IF NOT EXISTS "factory_written_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "factory_verified_at" TIMESTAMP(3);

-- Existing installations only contain the original three states. Convert the
-- column after adding the enum so revoked rows remain terminal.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'device_identities' AND column_name = 'state') = 'character varying'
     OR (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'device_identities' AND column_name = 'state') = 'text' THEN
    ALTER TABLE "device_identities" ALTER COLUMN "state" DROP DEFAULT;
    ALTER TABLE "device_identities"
      ALTER COLUMN "state" TYPE "DeviceIdentityState"
      USING "state"::text::"DeviceIdentityState";
    ALTER TABLE "device_identities" ALTER COLUMN "state" SET DEFAULT 'INVENTORY';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "manufacturing_batches" (
  "id" TEXT NOT NULL,
  "batch_number" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "hardware_revision" TEXT NOT NULL,
  "firmware_target" TEXT,
  "quantity" INTEGER NOT NULL,
  "status" "ManufacturingBatchStatus" NOT NULL DEFAULT 'DRAFT',
  "metadata" JSONB,
  "created_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manufacturing_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "device_qr_labels" (
  "id" TEXT NOT NULL,
  "qr_id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "batch_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 3,
  "issuer" TEXT NOT NULL,
  "kid" TEXT NOT NULL,
  "canonical_payload" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "state" "DeviceQrLabelState" NOT NULL DEFAULT 'ISSUED',
  "printed_at" TIMESTAMP(3),
  "printed_by_id" TEXT,
  "reprint_count" INTEGER NOT NULL DEFAULT 0,
  "revoked_at" TIMESTAMP(3),
  "revoke_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_qr_labels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "device_lifecycle_events" (
  "id" TEXT NOT NULL,
  "device_id" TEXT,
  "batch_id" TEXT,
  "qr_label_id" TEXT,
  "event_type" "DeviceLifecycleEventType" NOT NULL,
  "from_state" "DeviceIdentityState",
  "to_state" "DeviceIdentityState",
  "actor_type" TEXT NOT NULL,
  "actor_id" TEXT,
  "station_id" TEXT,
  "idempotency_key" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_lifecycle_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "device_claim_sessions" (
  "id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "farm_id" TEXT NOT NULL,
  "zone_id" TEXT,
  "deployment_mode" TEXT NOT NULL,
  "status" "DeviceClaimSessionStatus" NOT NULL DEFAULT 'CHALLENGE_ISSUED',
  "challenge" TEXT NOT NULL,
  "challenge_hash" TEXT NOT NULL,
  "attestation_signature" TEXT,
  "attestation_message" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "attested_at" TIMESTAMP(3),
  "finalized_at" TIMESTAMP(3),
  "finalized_node_id" TEXT,
  "idempotency_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_claim_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "manufacturing_batches_batch_number_key"
  ON "manufacturing_batches"("batch_number");
CREATE UNIQUE INDEX IF NOT EXISTS "device_qr_labels_qr_id_key"
  ON "device_qr_labels"("qr_id");
CREATE UNIQUE INDEX IF NOT EXISTS "device_qr_labels_device_id_key"
  ON "device_qr_labels"("device_id");
CREATE UNIQUE INDEX IF NOT EXISTS "device_lifecycle_events_idempotency_key_key"
  ON "device_lifecycle_events"("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "device_claim_sessions_idempotency_key_key"
  ON "device_claim_sessions"("idempotency_key");
CREATE INDEX IF NOT EXISTS "device_identities_batch_id_state_idx"
  ON "device_identities"("batch_id", "state");
CREATE INDEX IF NOT EXISTS "manufacturing_batches_status_created_at_idx"
  ON "manufacturing_batches"("status", "created_at");
CREATE INDEX IF NOT EXISTS "device_qr_labels_batch_id_state_idx"
  ON "device_qr_labels"("batch_id", "state");
CREATE INDEX IF NOT EXISTS "device_qr_labels_state_created_at_idx"
  ON "device_qr_labels"("state", "created_at");
CREATE INDEX IF NOT EXISTS "device_lifecycle_events_device_id_created_at_idx"
  ON "device_lifecycle_events"("device_id", "created_at");
CREATE INDEX IF NOT EXISTS "device_lifecycle_events_batch_id_created_at_idx"
  ON "device_lifecycle_events"("batch_id", "created_at");
CREATE INDEX IF NOT EXISTS "device_lifecycle_events_qr_label_id_created_at_idx"
  ON "device_lifecycle_events"("qr_label_id", "created_at");
CREATE INDEX IF NOT EXISTS "device_lifecycle_events_event_type_created_at_idx"
  ON "device_lifecycle_events"("event_type", "created_at");
CREATE INDEX IF NOT EXISTS "device_claim_sessions_device_id_status_expires_at_idx"
  ON "device_claim_sessions"("device_id", "status", "expires_at");
CREATE INDEX IF NOT EXISTS "device_claim_sessions_user_id_status_expires_at_idx"
  ON "device_claim_sessions"("user_id", "status", "expires_at");
CREATE INDEX IF NOT EXISTS "device_claim_sessions_expires_at_idx"
  ON "device_claim_sessions"("expires_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_identities_batch_id_fkey') THEN
    ALTER TABLE "device_identities"
      ADD CONSTRAINT "device_identities_batch_id_fkey"
      FOREIGN KEY ("batch_id") REFERENCES "manufacturing_batches"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_qr_labels_device_id_fkey') THEN
    ALTER TABLE "device_qr_labels"
      ADD CONSTRAINT "device_qr_labels_device_id_fkey"
      FOREIGN KEY ("device_id") REFERENCES "device_identities"("device_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_qr_labels_batch_id_fkey') THEN
    ALTER TABLE "device_qr_labels"
      ADD CONSTRAINT "device_qr_labels_batch_id_fkey"
      FOREIGN KEY ("batch_id") REFERENCES "manufacturing_batches"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_lifecycle_events_device_id_fkey') THEN
    ALTER TABLE "device_lifecycle_events"
      ADD CONSTRAINT "device_lifecycle_events_device_id_fkey"
      FOREIGN KEY ("device_id") REFERENCES "device_identities"("device_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_lifecycle_events_batch_id_fkey') THEN
    ALTER TABLE "device_lifecycle_events"
      ADD CONSTRAINT "device_lifecycle_events_batch_id_fkey"
      FOREIGN KEY ("batch_id") REFERENCES "manufacturing_batches"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_lifecycle_events_qr_label_id_fkey') THEN
    ALTER TABLE "device_lifecycle_events"
      ADD CONSTRAINT "device_lifecycle_events_qr_label_id_fkey"
      FOREIGN KEY ("qr_label_id") REFERENCES "device_qr_labels"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_claim_sessions_device_id_fkey') THEN
    ALTER TABLE "device_claim_sessions"
      ADD CONSTRAINT "device_claim_sessions_device_id_fkey"
      FOREIGN KEY ("device_id") REFERENCES "device_identities"("device_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
