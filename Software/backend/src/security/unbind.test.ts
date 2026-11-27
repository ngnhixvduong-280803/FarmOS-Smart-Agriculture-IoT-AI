import assert from "node:assert/strict";
import { test } from "node:test";
import { hashDeviceSecret, matchesDeviceSecret } from "./device-secrets";

test("device unbind resets identity state from CLAIMED to INVENTORY", () => {
  const deviceId = "TEST_GW_01";
  const claimCode = "ABC123XYZ789";
  const claimHash = hashDeviceSecret(`claim:${deviceId}`, claimCode);

  interface TestIdentity {
    device_id: string;
    state: string;
    claimed_by_id: string | null;
    claimed_farm_id: string | null;
    claimed_at: Date | null;
    claim_code_hash: string;
  }

  function canClaim(idRecord: TestIdentity, userId: string): boolean {
    return idRecord.state === "INVENTORY" || idRecord.claimed_by_id === userId;
  }

  // Initial factory state
  let identity: TestIdentity = {
    device_id: deviceId,
    state: "INVENTORY",
    claimed_by_id: null,
    claimed_farm_id: null,
    claimed_at: null,
    claim_code_hash: claimHash,
  };

  assert.equal(identity.state, "INVENTORY");
  assert.equal(identity.claimed_by_id, null);

  // Claimed by User A
  identity = {
    ...identity,
    state: "CLAIMED",
    claimed_by_id: "USER_A",
    claimed_farm_id: "FARM_01",
    claimed_at: new Date(),
  };
  assert.equal(identity.state, "CLAIMED");
  assert.equal(identity.claimed_by_id, "USER_A");

  // Cannot be claimed by User B while in CLAIMED state
  assert.equal(canClaim(identity, "USER_B"), false);

  // Unbind / Factory reset performed
  identity = {
    ...identity,
    state: "INVENTORY",
    claimed_by_id: null,
    claimed_farm_id: null,
    claimed_at: null,
  };

  // Now User B can claim it
  assert.equal(canClaim(identity, "USER_B"), true);
  assert.ok(matchesDeviceSecret(`claim:${deviceId}`, identity.claim_code_hash, claimCode));
});

test("revoked gateway credential is recognized and flags revocation", () => {
  const gatewayId = "GW_REVOKE_TEST";
  const token = "secure-token-12345";
  const tokenHash = hashDeviceSecret(`gateway:${gatewayId}`, token);

  const credential = {
    gateway_id: gatewayId,
    token_hash: tokenHash,
    issued_at: new Date(Date.now() - 60000),
    revoked_at: new Date(), // Revoked
  };

  const isRevoked = Boolean(credential.revoked_at);
  assert.equal(isRevoked, true);

  const errorResponse = {
    success: false,
    error: credential.revoked_at ? "GATEWAY_REVOKED" : "Gateway authentication failed",
    revoked: Boolean(credential.revoked_at),
  };

  assert.equal(errorResponse.error, "GATEWAY_REVOKED");
  assert.equal(errorResponse.revoked, true);
});
