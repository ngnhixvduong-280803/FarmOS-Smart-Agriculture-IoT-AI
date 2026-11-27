import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBoardForReflash } from '../src/boardManagement.ts';
import type { BoardPreflight, BoardProbe } from '../src/native';
const selection = { mac: 'aa:bb:cc:dd:ee:ff', deviceId: 'GATEWAY_1', releaseId: 'release' };
const probe = { ok: true, mac: selection.mac } as BoardProbe;
const registered = { currentDeviceId: selection.deviceId, release: { id: 'release' }, ready: false } as BoardPreflight;
const empty = { ...registered, currentDeviceId: null, ready: true };
test('remove exactly the confirmed identity and recheck readiness', async () => {
  const calls: string[] = [];
  let inspections = 0;
  const result = await prepareBoardForReflash(selection, {
    probe: async () => { calls.push('probe'); return probe; },
    inspect: async () => { calls.push('inspect'); return inspections++ === 0 ? registered : empty; },
    remove: async (id) => { calls.push(`delete:${id}`); },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(calls, ['probe', 'inspect', 'delete:GATEWAY_1', 'inspect']);
});
test('changed board, identity or firmware prevents deletion', async () => {
  for (const [physical, current] of [
    [{ ...probe, mac: '00:11:22:33:44:55' }, registered],
    [probe, { ...registered, currentDeviceId: 'GATEWAY_2' }],
    [probe, { ...registered, release: { id: 'other' } }],
  ] as [BoardProbe, BoardPreflight][]) {
    let deleted = false;
    await assert.rejects(prepareBoardForReflash(selection, {
      probe: async () => physical, inspect: async () => current,
      remove: async () => { deleted = true; },
    }));
    assert.equal(deleted, false);
  }
});
test('failed server deletion or stale registration never returns ready', async () => {
  await assert.rejects(prepareBoardForReflash(selection, {
    probe: async () => probe, inspect: async () => registered,
    remove: async () => { throw new Error('server refused'); },
  }), /server refused/);
  await assert.rejects(prepareBoardForReflash(selection, {
    probe: async () => probe, inspect: async () => registered, remove: async () => {},
  }), /Server vẫn/);
});
