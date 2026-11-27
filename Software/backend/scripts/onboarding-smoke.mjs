// Explicit live API integration test. Creates isolated TEST fixtures, never uses
// a customer's session. Credentials and fixture manifest stay Git-ignored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize creating test fixtures');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = dotenv.parse(fs.readFileSync(path.join(repo, '.env')));
const origin = new URL(env.BACKEND_API_URL).origin;
assert.ok(origin.startsWith('https://'));
const folder = path.join(repo, '.local-backups', 'bench-20260905');
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const manifestPath = path.join(folder, 'api-test-fixtures.json');
const runId = crypto.randomBytes(5).toString('hex');
const manifest = { runId, origin, createdAt: new Date().toISOString(), users: [], devices: [], checks: [] };
const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
const pass = name => { manifest.checks.push(name); save(); console.log(`PASS ${name}`); };
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
async function api(route, body, headers = {}, expected = 200) {
  const res = await fetch(`${origin}/api/v1${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const result = await res.json();
  assert.equal(res.status, expected, `${route}: unexpected HTTP ${res.status}`);
  if (expected < 300) assert.equal(result.success, true, `${route}: success=false`);
  return result.data;
}
async function account(index) {
  const email = `farmos-bench-${runId}-${index}@example.com`;
  const password = crypto.randomBytes(32).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true,
    user_metadata: { name: `TEST FarmOS bench ${runId}-${index}` } });
  if (error) throw new Error(`Test account creation failed (${error.status})`);
  const record = { id: data.user.id, email, password };
  manifest.users.push(record); save();
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw new Error(`Test login failed (${login.error.status})`);
  const session = await api('/auth/mobile/session', { accessToken: login.data.session.access_token });
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const farms = await api('/farms', undefined, headers);
  const zones = await api('/zones', undefined, headers);
  record.farmId = farms[0]?.id; record.zoneId = zones[0]?.id; save();
  assert.ok(record.farmId && record.zoneId);
  return { ...record, headers };
}
try {
  await api('/onboarding/gateway/pairing-sessions/next', undefined, {}, 401);
  pass('anonymous gateway rejected');
  const owner = await account(1);
  const other = await account(2);
  pass('real identity login and mobile session exchange; default farm/zone');
  const gatewayId = `TEST_GW_${runId}`;
  const nodeId = `TEST_NODE_${runId}`;
  const claim = crypto.randomBytes(32).toString('base64url');
  manifest.devices = [gatewayId, nodeId]; save();
  await api('/nodes/provision', { devices: [
    { id: gatewayId, type: 'GATEWAY', farmId: owner.farmId, claimCode: claim },
    { id: nodeId, type: 'SENSOR_NODE', farmId: owner.farmId, claimCode: claim },
  ] }, { 'x-farmos-device-token': env.DEVICE_INGEST_TOKEN });
  const claimBody = { gatewayId, claimCode: claim, farmId: owner.farmId };
  await api('/onboarding/gateways/claim-session', claimBody, other.headers, 403);
  pass('cross-account farm claim rejected');
  const session = await api('/onboarding/gateways/claim-session', claimBody, owner.headers, 201);
  const redeemBody = { gatewayId, sessionId: session.sessionId, provisioningToken: session.provisioningToken };
  const first = await api('/onboarding/gateways/redeem', redeemBody);
  const retry = await api('/onboarding/gateways/redeem', redeemBody);
  assert.equal(first.gatewayAccessToken, retry.gatewayAccessToken);
  pass('gateway claim and lost-response redeem retry');
  const gatewayHeaders = { 'x-farmos-gateway-id': gatewayId, 'x-farmos-gateway-token': first.gatewayAccessToken };
  await api('/onboarding/gateways/claim-session', { ...claimBody, farmId: other.farmId }, other.headers, 409);
  pass('already owned gateway cannot be stolen');
  const pairingBody = { nodeId, gatewayId, possessionCode: claim, farmId: owner.farmId, zoneId: owner.zoneId };
  const old = await api('/onboarding/nodes/pairing-sessions', pairingBody, owner.headers, 201);
  const pairing = await api('/onboarding/nodes/pairing-sessions', pairingBody, owner.headers, 201);
  await api(`/onboarding/gateway/pairing-sessions/${old.pairingId}/confirm`, { radioToken: old.radioToken }, gatewayHeaders, 409);
  pass('cancelled pairing cannot become active');
  const grant = await api('/onboarding/gateway/pairing-sessions/next', undefined, gatewayHeaders);
  assert.equal(grant.pairingId, pairing.pairingId); assert.ok(grant.ttlMs > 0);
  await api(`/onboarding/gateway/pairing-sessions/${pairing.pairingId}/confirm`, { radioToken: 'wrong' }, gatewayHeaders, 401);
  await api(`/onboarding/gateway/pairing-sessions/${pairing.pairingId}/confirm`, { radioToken: pairing.radioToken }, gatewayHeaders);
  pass('selected gateway grant and token verification (API simulation, not LoRa)');
  const frame = { nodeId, eventId: `${nodeId}-1-1`, soil_temp: 28.25 };
  await api('/onboarding/gateway/telemetry', { ...frame, soil_temp: null }, gatewayHeaders, 400);
  await api('/onboarding/gateway/telemetry', { ...frame, nodeId: 'NOT_BOUND' }, gatewayHeaders, 403);
  const stored = await api('/onboarding/gateway/telemetry', frame, gatewayHeaders);
  const duplicate = await api('/onboarding/gateway/telemetry', frame, gatewayHeaders);
  assert.ok(stored.persisted && stored.telemetryId && !stored.duplicate && duplicate.duplicate);
  const latest = await api(`/telemetry/zones/${owner.zoneId}/latest`, undefined, owner.headers);
  assert.equal(latest.id, stored.telemetryId); assert.equal(latest.soil_temp, 28.25);
  assert.equal(latest.soil_moisture, null);
  pass('valid DS18B20 row read back via API; duplicate and invalid reading rejected');
  console.log(`Fixtures retained for audit at ${manifestPath}; no physical board pairing claimed.`);
} catch (error) {
  manifest.failure = error.message; save();
  console.error(error.message); process.exitCode = 1;
}
