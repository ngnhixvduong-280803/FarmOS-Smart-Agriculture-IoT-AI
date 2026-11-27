-- Additive: no changes to physical telemetry, identities or farm data.
CREATE TABLE "simulation_samples" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "farm_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "simulated_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "manifest" JSONB NOT NULL,
    "observations" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "ground_truth" JSONB NOT NULL,
    CONSTRAINT "simulation_samples_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "simulation_samples_gateway_id_event_id_key" ON "simulation_samples"("gateway_id", "event_id");
CREATE INDEX "simulation_samples_farm_id_run_id_sequence_id_idx" ON "simulation_samples"("farm_id", "run_id", "sequence", "id");

CREATE INDEX "simulation_samples_farm_id_node_id_received_at_idx" ON "simulation_samples"("farm_id", "node_id", "received_at");
CREATE INDEX "simulation_samples_farm_id_gateway_id_received_at_idx" ON "simulation_samples"("farm_id", "gateway_id", "received_at");
