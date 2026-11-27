import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewaySessionToken, hashDeviceSecret, isProvisioningSessionUsable, matchesDeviceSecret } from "./device-secrets";

test("redeem retry derives identical token; replacement session differs", () => {
  const token = gatewaySessionToken("GW1", "session1", "provisioning-secret");
  assert.equal(token, gatewaySessionToken("GW1", "session1", "provisioning-secret"));
  assert.notEqual(token, gatewaySessionToken("GW1", "session2", "provisioning-secret"));
  assert.notEqual(token, gatewaySessionToken("GW2", "session1", "provisioning-secret"));
  assert.notEqual(token, gatewaySessionToken("GW1", "session1", "wrong-secret"));
  assert.equal(token.length, 64);
});
test("hash verification rejects wrong scope and malformed hash", () => {
  const hash = hashDeviceSecret("gateway:GW1", "secret");
  assert.ok(matchesDeviceSecret("gateway:GW1", hash, "secret"));
  assert.ok(!matchesDeviceSecret("gateway:GW2", hash, "secret"));
  assert.ok(!matchesDeviceSecret("gateway:GW1", "invalid", "secret"));
});

test("claim provisioning is device-bound, expiring, and idempotent only for the same session", () => {
  const now = new Date("2026-09-08T00:00:00.000Z");
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const provisioningToken = "short-lived-claim-token";
  const tokenHash = hashDeviceSecret("provision:GW1", provisioningToken);

  assert.ok(isProvisioningSessionUsable("PENDING", expiresAt, now));
  assert.ok(isProvisioningSessionUsable("REDEEMED", expiresAt, now));
  assert.ok(matchesDeviceSecret("provision:GW1", tokenHash, provisioningToken));
  assert.ok(!matchesDeviceSecret("provision:GW2", tokenHash, provisioningToken));
  assert.ok(!matchesDeviceSecret("provision:GW1", tokenHash, "replayed-for-another-session"));
  assert.ok(!isProvisioningSessionUsable("PENDING", expiresAt, new Date(expiresAt.getTime() + 1)));
  assert.ok(!isProvisioningSessionUsable("CANCELLED", expiresAt, now));
  assert.notEqual(
    gatewaySessionToken("GW1", "claim-session-1", provisioningToken),
    gatewaySessionToken("GW1", "claim-session-2", provisioningToken),
  );
});
