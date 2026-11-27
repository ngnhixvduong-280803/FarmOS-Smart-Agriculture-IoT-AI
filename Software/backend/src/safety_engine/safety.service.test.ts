import assert from "node:assert/strict";
import { test } from "node:test";
import { safetyEngine } from "./safety.service";

test("tank interlock starts stale and becomes usable only after a complete update", () => {
  assert.equal(safetyEngine.hasFreshTankState(), false);
  safetyEngine.updateTankState(55, true);
  assert.equal(safetyEngine.hasFreshTankState(), true);
  assert.deepEqual(safetyEngine.getTankState().safe, true);
});
