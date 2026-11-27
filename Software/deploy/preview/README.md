# Isolated VPS API preview

Purpose: validate PR API/web/firmware contracts on the FarmOS VPS while production
remains on its reviewed release. This is an independent Compose project, database,
network and volumes. Never load `/opt/farmos/.env` or production DB secrets.
HTTP listeners bind to VPS loopback and are accessible through an SSH tunnel only.
The browser shows the actual frontend and native device detail, not a mocked UI.

Current runtime is installed at `/opt/farmos/api-preview`. Public repo files contain
no credentials. The local operator copy of preview login is ignored under
`.local-backups/api-preview/credentials.json` (0600); VPS copies are root-only.

## Runtime setup

- Build backend from the branch using `backend/Dockerfile`, frontend with
  `VITE_PREVIEW_LOGIN=true`, empty VITE_SUPABASE_URL/ANON_KEY/GOOGLE_CLIENT_ID.
- An additive build may layer branch `dist` and `prisma` over an exact trusted
  backend image **only when dependency lockfiles match**; run `prisma generate`
  inside Linux. The deployed preview used production base SHA bfec96c plus
  preview source revision4fd7cb5. Frontend revision257c91b has the explicit preview login and nullable sensor display; simulator3aea412 adds shared cadence display over enginea981055.
- Set PREVIEW_REVISION (backend) and PREVIEW_WEB_REVISION (frontend) in preview `.env`. Images must use those exact tags; updating frontend does not restart the API or simulator.
- Generate independent random POSTGRES_PASSWORD/JWT_SECRET/HARDWARE_BOARD_HMAC_SECRET
  in `private.env`0600, plus DATABASE_URL/DIRECT_URL pointing only to
  `postgresql://farmos_preview:<password>@db:5432/farmos_preview`.
- `docker compose -f compose.yml up -d db`, then run backend
  `npx prisma db push --skip-generate` **only against this new preview DB**.
  This does not validate production migration history.
- Seed a dedicated preview account with a random password hash; do not copy a
  production account/password/provider token. Keep login in credentials.json0600.
- Run `dist/simulation/provision.cli.js --farm SIM_VPS_API_LAB --owner-email
  preview@farmos.invalid --api http://127.0.0.1:3000 --output /run/preview/simulator.env`
  with a root-only persistent host directory mounted at `/run/preview`.
  Do not write credential output into a disposable container's `/tmp`.
- `docker compose -f compose.yml up -d backend frontend simulator`.
  Simulator shares the backend network namespace for authenticated loopback API,
  avoiding plaintext HTTP on a public network. It uses a separate preview volume.

Preview has explicit local password auth on the backend and a separate frontend
build opt-in restricted to localhost/127.0.0.1; production defaults remain OAuth.
Legacy onboarding/MQTT ingest and irrigation remain disabled.

## Open locally

```sh
ssh -NT -L 4080:127.0.0.1:14080 -L 4081:127.0.0.1:14081 \
  -L 4011:127.0.0.1:14010 farmos
```

- Web: http://127.0.0.1:4080/nodes
- API: http://127.0.0.1:4081
- Simulator: http://127.0.0.1:4011

The earlier independent simulator at port4010 is retained with its original queue.
No existing samples are relabeled or silently moved into production.

## Verification and maintenance

`docs/firmware-api/tools/verify-preview.cjs` checks the exact preview DB guard,
creates only clearly named API fixtures, and validates authenticated ingestion,
deduplication, sensor-field validation, revocation, scoped device reads and
representative samples from each preset. It needs the deployed simulator `dist/lab`
at `/app/preview-lab` and preview simulator.env at `/run/preview/simulator.env`;
its output contains sample IDs/latency, never tokens. Fixture tokens are rotated
only within preview. It is not a production load-test script.

The API benchmark is bounded at60 sequential requests,2/sec. The normal API limit
is300/minute/IP; do not run repeated bursts against production or interpret these
measurements as fleet capacity. Use `/readyz` plus actual authenticated write/read
checks for deployment acceptance. Keep physical-device proof as a separate gate.

To stop: `docker compose -f compose.yml down` (preserves preview data).
Do not use `down -v` or remove existing production volumes. Production deployment
still follows `deploy/README.md` and the required PR review/CI workflow.
