CREATE TABLE "ingest_events" (
    "event_id" TEXT NOT NULL,
    "message_type" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_events_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "ingest_events_received_at_idx" ON "ingest_events"("received_at");
