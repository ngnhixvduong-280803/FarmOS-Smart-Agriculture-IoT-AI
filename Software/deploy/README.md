# FarmOS CI/CD: simple, public-repo safe setup

There are only two CI/CD configuration files to maintain:

1. `.github/workflows/ci-cd.yml` — CI, image build, and production deployment.
2. `deploy/farmos-release-run` — VPS bootstrap and release runner.

The production runtime remains Docker Compose in `docker-compose.production.yml`. The VPS pulls exact Docker images by commit SHA; it never uses `latest` or `production` tags.

## Everyday workflow

1. Create a branch and open a pull request to `main`.
2. The single **FarmOS CI/CD** workflow builds backend, frontend, and simulator.
3. Merge only when CI passes.
4. The same workflow builds immutable images and deploys the merged commit to the VPS.

For a retry without a code change, use **Actions → FarmOS CI/CD → Run workflow** on `main`. Do not SSH to the VPS to deploy application code.

## One-time setup

The current FarmOS VPS is already bootstrapped. For a fresh VPS:

1. Install Docker Engine, Docker Compose plugin, Git, `sudo`, and OpenSSH server.
2. Create `/opt/farmos/.env` from `.env.example`; set it to `root:root` and `600`. This is the only file containing production secrets and it must never enter Git.
3. Generate a dedicated GitHub Actions ED25519 key pair and run:

   ```sh
   sudo FARMOS_DEPLOY_PUBLIC_KEY="$(cat /secure/path/farmos-deploy.pub)" \
     ./deploy/farmos-release-run --bootstrap
   ```

   It creates the operational `farmos-admin` user and the limited `farmos-deploy` account. `farmos-admin` receives the current root SSH public key and Docker access; `farmos-deploy` has no shell, PTY, port forwarding, or agent forwarding and can only run the release runner. The bootstrap then disables root/password SSH login.
4. Add GitHub Actions secrets:

   - `FARMOS_DEPLOY_SSH_KEY` — private key from step 3
   - `FARMOS_DEPLOY_HOST` — VPS hostname or IP
   - `FARMOS_DEPLOY_KNOWN_HOSTS` — pinned output from `ssh-keyscan -H <host>`

5. Add GitHub Actions variables:

   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_GOOGLE_CLIENT_ID`

## Public repository safety

- Keep `.env`, MQTT passwords, certificates, Cloudflare token, database URLs, service-role keys, and deploy private keys out of Git.
- Keep the GHCR images public only if the VPS must pull without registry credentials; images must contain no secrets because frontend `VITE_*` values are public by design.
- Enable Secret Scanning, Push Protection, Dependabot alerts/security updates, and the `main` branch ruleset requiring the three CI jobs and review for `.github/`, `deploy/`, and production Compose changes.
- Docker image labels and deployment state use the commit SHA, so the running server revision is auditable. The release runner keeps each release's production Compose file under `/opt/farmos/releases/<sha>/` while pinning the historical Compose project name (`farmos` by default), and only switches the active Compose file after the candidate is healthy. A failed container health check restores the previous image with the previous commit's matching Compose contract; it does not reuse the failed candidate's ports, mounts, or service settings. Database migrations must remain backward-compatible; container rollback cannot undo a schema migration.
- The release runner executes `node dist/config/preflight.js` in the candidate backend image before migration. It stops with redacted variable names when the production env is incomplete, and prints scrubbed candidate `ps`/logs before any health-failure rollback. The backend, Nginx proxy, and healthcheck use internal port `3000`.

## MQTT boundary

Port 1883 stays inside Docker. The current password/ACL setup is a migration-only baseline; do not give a physical gateway the backend MQTT account.

Before deploying ESP32 firmware, stage `deploy/mosquitto/mosquitto-mtls.conf.example` as `/opt/farmos/mosquitto/mosquitto.conf` with a tested public gateway CA and `gateway-acl`. The public listener then requires a unique client certificate whose CN equals `GATEWAY_ID`; backend MQTT remains password-authenticated only on Docker-internal port 1883. Use `deploy/provision-mqtt-gateway-mtls` to install the public CA and a least-privilege ACL block. Generate and retain the CA private key, client private key and any certificate inventory off the VPS and out of Git.

Validate the staged config in a disposable Mosquitto container before a restart. Once mTLS is active, revoke a lost gateway by removing its ACL block, placing its certificate in the CA CRL, then reloading/restarting Mosquitto. The Simulator accepts only the mTLS contract for remote brokers and exercises QoS 1 outbox/retry behavior before firmware exists.
