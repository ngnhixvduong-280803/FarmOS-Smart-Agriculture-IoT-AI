CREATE TABLE "ota_events" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "device_type" TEXT NOT NULL,
    "target_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" INTEGER,
    "error" TEXT,
    "reporter_type" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ota_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ota_events_device_id_created_at_idx" ON "ota_events"("device_id", "created_at");
CREATE INDEX "ota_events_status_created_at_idx" ON "ota_events"("status", "created_at");

ALTER TABLE "ota_events"
ADD CONSTRAINT "ota_events_device_id_fkey"
FOREIGN KEY ("device_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
