-- Existing production databases predate the gateway-to-node association even
-- though the baseline schema already declares it. Keep this migration
-- idempotent so it is also safe after a fresh baseline install.
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "gateway_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'nodes_gateway_id_fkey'
      AND conrelid = '"nodes"'::regclass
  ) THEN
    ALTER TABLE "nodes"
      ADD CONSTRAINT "nodes_gateway_id_fkey"
      FOREIGN KEY ("gateway_id") REFERENCES "nodes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
