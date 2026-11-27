import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRestorer } from "../src/session.ts";

test("dev remount shares restoration and rebuilds native authorization from the saved session", async () => {
  let exchanges = 0;
  const auth = { getSession: async () => ({ data: { session: { access_token: "saved-session" } }, error: null }) };
  const restore = createSessionRestorer(auth, async (token) => {
    assert.equal(token, "saved-session");
    exchanges++;
    return { role: "ADMIN" };
  });
  const first = restore();
  assert.equal(restore(), first);
  assert.deepEqual(await first, { role: "ADMIN" });
  assert.equal(exchanges, 1);
  assert.deepEqual(await restore(), { role: "ADMIN" });
  assert.equal(exchanges, 2);
});

test("missing or expired sessions never open the signed-in screen", async () => {
  let exchanges = 0;
  const exchange = async () => { exchanges++; return {}; };
  assert.equal(await createSessionRestorer(null, exchange)(), null);
  assert.equal(await createSessionRestorer({ getSession: async () => ({ data: { session: null }, error: null }) }, exchange)(), null);
  await assert.rejects(createSessionRestorer({ getSession: async () => ({ data: { session: null }, error: { message: "expired" } }) }, exchange), /expired/);
  assert.equal(exchanges, 0);
});

test("server authorization is mandatory and transient failures remain retryable", async () => {
  let requests = 0;
  const restore = createSessionRestorer({ getSession: async () => ({ data: { session: { access_token: "saved-session" } }, error: null }) }, async () => {
    if (++requests === 1) throw new Error("server unavailable");
    return { role: "ADMIN" };
  });
  await assert.rejects(restore, /server unavailable/);
  assert.deepEqual(await restore(), { role: "ADMIN" });
});

test("hung storage times out and late credentials cannot exchange authorization", async () => {
  let resolveSession!: (value: { data: { session: { access_token: string } }; error: null }) => void;
  let calls = 0;
  let exchanges = 0;
  const restore = createSessionRestorer({ getSession: () => ++calls === 1
    ? new Promise(resolve => { resolveSession = resolve; })
    : Promise.resolve({ data: { session: { access_token: "retry" } }, error: null })
  }, async () => { exchanges++; return { role: "ADMIN" }; }, 10);
  await assert.rejects(restore(), /SESSION_RESTORE_TIMEOUT/);
  resolveSession({ data: { session: { access_token: "late" } }, error: null });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(exchanges, 0);
  assert.deepEqual(await restore(), { role: "ADMIN" });
  assert.equal(exchanges, 1);
});
