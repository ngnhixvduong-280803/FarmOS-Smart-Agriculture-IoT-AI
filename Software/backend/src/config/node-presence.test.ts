import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "./env";
import { isNodeOnline } from "../telemetry/node-presence";

test("node presence expires a cached online flag without a fresh heartbeat", () => {
  const now = Date.now();
  assert.equal(isNodeOnline({ online: true, last_seen: new Date(now) }, now), true);
  assert.equal(
    isNodeOnline({ online: true, last_seen: new Date(now - (env.NODE_ONLINE_TTL_SEC + 1) * 1000) }, now),
    false,
  );
  assert.equal(isNodeOnline({ online: false, last_seen: new Date(now) }, now), false);
  assert.equal(isNodeOnline({ online: true, last_seen: null }, now), false);
});
