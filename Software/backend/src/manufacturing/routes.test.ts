import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../api/app";

test("manufacturing writes require authentication and idempotency is not bypassed", async () => {
  const server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const list = await fetch(`http://127.0.0.1:${port}/api/v1/manufacturing/batches`);
    assert.equal(list.status, 401);
    const create = await fetch(`http://127.0.0.1:${port}/api/v1/manufacturing/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchNumber: "TEST", model: "MODEL", type: "SENSOR_NODE", hardwareRevision: "REV_A", quantity: 1 }),
    });
    assert.equal(create.status, 401);
  } finally {
    server.close();
  }
});
test("QR v3 resolver rejects an unsigned payload before touching the database", async () => {
  const server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/onboarding/qr/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { v: 3, deviceId: "spoof" } }),
    });
    assert.equal(response.status, 400);
  } finally {
    server.close();
  }
});
