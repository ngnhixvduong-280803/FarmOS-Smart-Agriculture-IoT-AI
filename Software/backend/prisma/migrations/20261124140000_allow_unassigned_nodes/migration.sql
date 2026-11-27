BEGIN;
SET LOCAL lock_timeout = '5s';

-- Released devices keep their Node and telemetry but no longer belong to a farm.
ALTER TABLE "public"."nodes" ALTER COLUMN "farm_id" DROP NOT NULL;

COMMIT;
