ALTER TABLE "device_identities"
  ADD COLUMN IF NOT EXISTS "firmware_target" TEXT NOT NULL DEFAULT 'ESP32S3_LORA_SENSOR_V1',
  ADD COLUMN IF NOT EXISTS "hardware_revision" TEXT NOT NULL DEFAULT 'REV_A',
  ADD COLUMN IF NOT EXISTS "partition_scheme" TEXT NOT NULL DEFAULT 'FARMOS_16M_V1',
  ADD COLUMN IF NOT EXISTS "bootloader_version" TEXT;

UPDATE "device_identities"
SET "firmware_target" = CASE
  WHEN "type" = 'GATEWAY' THEN 'ESP32S3_LORA_GATEWAY_V1'
  ELSE 'ESP32S3_LORA_SENSOR_V1'
END;

CREATE INDEX "device_identities_firmware_target_hardware_revision_idx"
  ON "device_identities"("firmware_target", "hardware_revision");

CREATE TABLE "ota_update_jobs" (
  "id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "firmware_target" TEXT NOT NULL,
  "target_version" TEXT NOT NULL,
  "target_sha256" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "initiated_by_type" TEXT NOT NULL,
  "initiated_by_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ota_update_jobs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ota_events" ADD COLUMN IF NOT EXISTS "job_id" TEXT;

CREATE UNIQUE INDEX "ota_update_jobs_device_id_release_id_key"
  ON "ota_update_jobs"("device_id", "release_id");
CREATE INDEX "ota_update_jobs_device_id_status_idx"
  ON "ota_update_jobs"("device_id", "status");
CREATE INDEX "ota_update_jobs_expires_at_idx"
  ON "ota_update_jobs"("expires_at");

ALTER TABLE "ota_update_jobs"
  ADD CONSTRAINT "ota_update_jobs_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ota_events"
  ADD CONSTRAINT "ota_events_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "ota_update_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
