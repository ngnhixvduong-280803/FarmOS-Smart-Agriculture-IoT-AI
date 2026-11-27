-- Baseline for the schema already present in the restored production database.
--
-- This migration is intentionally recorded as applied with `prisma migrate
-- resolve`; it is never executed against the existing database. It was
-- generated from the FarmOS schema at b86d87f, immediately before Prisma
-- Migrate was introduced. Later migrations remain executable normally.

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_farms" (
    "user_id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,

    CONSTRAINT "user_farms_pkey" PRIMARY KEY ("user_id","farm_id")
);

-- CreateTable
CREATE TABLE "farms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "farms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "crop_type" TEXT,
    "target_moisture_min" DOUBLE PRECISION NOT NULL DEFAULT 40.0,
    "target_moisture_max" DOUBLE PRECISION NOT NULL DEFAULT 70.0,
    "valve_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" TEXT NOT NULL,
    "serial_number" TEXT,
    "name" TEXT,
    "farm_id" TEXT NOT NULL,
    "zone_id" TEXT,
    "owner_id" TEXT,
    "type" TEXT NOT NULL DEFAULT 'SENSOR_NODE',
    "gateway_id" TEXT,
    "is_activated" BOOLEAN NOT NULL DEFAULT false,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "battery_pct" DOUBLE PRECISION,
    "rssi" DOUBLE PRECISION,
    "firmware_version" TEXT,
    "last_seen" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry_data" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "farm_id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "soil_moisture" DOUBLE PRECISION NOT NULL,
    "soil_temp" DOUBLE PRECISION,
    "air_temp" DOUBLE PRECISION,
    "air_humidity" DOUBLE PRECISION,
    "lux" DOUBLE PRECISION,
    "battery_pct" DOUBLE PRECISION,
    "quality" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telemetry_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "irrigation_logs" (
    "id" TEXT NOT NULL,
    "command_id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "valve_id" TEXT,
    "duration_sec" INTEGER NOT NULL,
    "trigger_source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rejection_reason" TEXT,
    "measured_flow_liters" DOUBLE PRECISION,
    "safety_checks_passed" BOOLEAN NOT NULL DEFAULT true,
    "error_code" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "irrigation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "zone_id" TEXT,
    "level" TEXT NOT NULL DEFAULT 'WARNING',
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crop_profiles" (
    "id" TEXT NOT NULL,
    "crop_name" TEXT NOT NULL,
    "description" TEXT,
    "optimal_moisture_min" DOUBLE PRECISION NOT NULL,
    "optimal_moisture_max" DOUBLE PRECISION NOT NULL,
    "optimal_temp_min" DOUBLE PRECISION,
    "optimal_temp_max" DOUBLE PRECISION,
    "water_requirement_desc" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crop_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_serial_number_key" ON "nodes"("serial_number");

-- CreateIndex
CREATE INDEX "telemetry_data_zone_id_timestamp_idx" ON "telemetry_data"("zone_id", "timestamp");

-- CreateIndex
CREATE INDEX "telemetry_data_node_id_timestamp_idx" ON "telemetry_data"("node_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "irrigation_logs_command_id_key" ON "irrigation_logs"("command_id");

-- CreateIndex
CREATE INDEX "irrigation_logs_zone_id_created_at_idx" ON "irrigation_logs"("zone_id", "created_at");

-- CreateIndex
CREATE INDEX "alerts_farm_id_resolved_idx" ON "alerts"("farm_id", "resolved");

-- CreateIndex
CREATE UNIQUE INDEX "crop_profiles_crop_name_key" ON "crop_profiles"("crop_name");

-- AddForeignKey
ALTER TABLE "user_farms" ADD CONSTRAINT "user_farms_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_farms" ADD CONSTRAINT "user_farms_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_data" ADD CONSTRAINT "telemetry_data_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_data" ADD CONSTRAINT "telemetry_data_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "irrigation_logs" ADD CONSTRAINT "irrigation_logs_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
