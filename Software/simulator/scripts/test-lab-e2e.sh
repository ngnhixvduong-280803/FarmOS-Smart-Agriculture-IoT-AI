#!/bin/sh
# Disposable PostgreSQL only. Never reads or resets the application's DATABASE_URL.
set -eu
TASK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TASK_TMP=$(mktemp -d)
TASK_CONTAINER=""
cleanup() {
  if [ -n "$TASK_CONTAINER" ]; then docker rm -fv "$TASK_CONTAINER" >/dev/null; fi
  rm -rf "$TASK_TMP"
}
trap cleanup EXIT INT TERM
cd "$TASK_ROOT"
npm --prefix simulator run build
npm --prefix backend run prisma:generate
npm --prefix backend run build
TASK_CONTAINER=$(docker run -d --rm -e POSTGRES_PASSWORD=lab-test-only-password -e POSTGRES_DB=farmos_lab_test -p 127.0.0.1:55439:5432 postgres:16-alpine)
TASK_READY=0
for TASK_ATTEMPT in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "$TASK_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then TASK_READY=1; break; fi
  sleep 1
done
[ "$TASK_READY" = 1 ] || exit 1
export DATABASE_URL='postgresql://postgres:lab-test-only-password@127.0.0.1:55439/farmos_lab_test'
export DIRECT_URL="$DATABASE_URL"
export NODE_ENV=test
export JWT_SECRET=simulation-integration-test-secret-over-32-chars
node -e "const fs=require('fs'); const text=fs.readFileSync('backend/prisma/schema.prisma','utf8'); fs.writeFileSync(process.argv[1],text.slice(0,text.indexOf('// Synthetic observations are isolated')).replace(/^  journal_entries FarmJournalEntry\[\]\s*$/m,''));" "$TASK_TMP/base.prisma"
backend/node_modules/.bin/prisma db push --skip-generate --schema "$TASK_TMP/base.prisma"
docker exec -i "$TASK_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d farmos_lab_test < backend/prisma/migrations/20261016090000_simulation_datasets/migration.sql
docker exec -i "$TASK_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d farmos_lab_test < backend/prisma/migrations/20261123150000_simulation_hourly_retention/migration.sql
cd backend
node --test dist/simulation/e2e.test.js
