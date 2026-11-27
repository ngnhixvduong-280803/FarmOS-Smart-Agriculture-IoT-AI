ALTER TABLE "nodes" ADD COLUMN "pump_ready_at" TIMESTAMP(3);

CREATE TABLE "pump_commands" (
    "id" TEXT PRIMARY KEY,
    "node_id" TEXT NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "requested_by_id" TEXT NOT NULL,
    "turn_on" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING'
        CHECK ("status" IN ('PENDING', 'DELIVERED', 'CONFIRMED', 'FAILED', 'CANCELLED')),
    "error_code" TEXT,
    "feedback_on" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3)
);

CREATE INDEX "pump_commands_node_id_created_at_idx" ON "pump_commands"("node_id", "created_at");
ALTER TABLE "pump_commands" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "pump_commands" FROM PUBLIC;


DO $$
DECLARE role_name text;
BEGIN
    FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
    LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.pump_commands FROM %I', role_name);
    END LOOP;
END $$;
