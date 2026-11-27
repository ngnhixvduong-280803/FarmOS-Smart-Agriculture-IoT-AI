CREATE TABLE IF NOT EXISTS "device_identities" (
    "device_id" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "model" TEXT,
    "ble_name" TEXT,
    "claim_code_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'INVENTORY',
    "claimed_by_id" TEXT,
    "claimed_farm_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_identities_pkey" PRIMARY KEY ("device_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "device_identities_serial_number_key"
    ON "device_identities"("serial_number");
CREATE INDEX IF NOT EXISTS "device_identities_state_type_idx"
    ON "device_identities"("state", "type");

CREATE TABLE IF NOT EXISTS "gateway_provisioning_sessions" (
    "id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gateway_provisioning_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gateway_provisioning_sessions_gateway_id_status_idx"
    ON "gateway_provisioning_sessions"("gateway_id", "status");
CREATE INDEX IF NOT EXISTS "gateway_provisioning_sessions_expires_at_idx"
    ON "gateway_provisioning_sessions"("expires_at");

CREATE TABLE IF NOT EXISTS "gateway_credentials" (
    "gateway_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "gateway_credentials_pkey" PRIMARY KEY ("gateway_id")
);

CREATE TABLE IF NOT EXISTS "pairing_sessions" (
    "id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "gateway_ready_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "last_rssi" DOUBLE PRECISION,
    "last_snr" DOUBLE PRECISION,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pairing_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "pairing_sessions_gateway_id_status_expires_at_idx"
    ON "pairing_sessions"("gateway_id", "status", "expires_at");
CREATE INDEX IF NOT EXISTS "pairing_sessions_node_id_status_idx"
    ON "pairing_sessions"("node_id", "status");

CREATE TABLE IF NOT EXISTS "node_gateway_bindings" (
    "id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "paired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "node_gateway_bindings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "node_gateway_bindings_node_id_status_idx"
    ON "node_gateway_bindings"("node_id", "status");
CREATE INDEX IF NOT EXISTS "node_gateway_bindings_gateway_id_status_idx"
    ON "node_gateway_bindings"("gateway_id", "status");

-- Temperature-only products (for example the current DS18B20 Node) must not
-- fabricate soil moisture merely to satisfy the ingest contract.
ALTER TABLE "telemetry_data" ALTER COLUMN "soil_moisture" DROP NOT NULL;
