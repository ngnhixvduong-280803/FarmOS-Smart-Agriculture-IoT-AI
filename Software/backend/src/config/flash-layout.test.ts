import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadFlashLayout } from "./flash-layout";

function validLayout() {
  return {
    layoutId: "TEST_LAYOUT",
    partitionTable: { offset: 0x10000 },
    normalReflash: { readbackOffset: 0x20000 },
    writePlans: {
      NORMAL_REFLASH: [{ role: "APP", address: 0x20000 }],
      FACTORY_FULL_FLASH: [{ role: "BOOTLOADER", address: 0 }],
    },
  };
}

function temporaryLayoutTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farmos-flash-layout-"));
  const appDir = path.join(root, "app");
  const firmwareDir = path.join(appDir, "firmware");
  fs.mkdirSync(firmwareDir, { recursive: true });
  const layoutPath = path.join(firmwareDir, "flash_layout.json");
  fs.writeFileSync(layoutPath, JSON.stringify(validLayout()));
  return { root, appDir, firmwareDir, layoutPath };
}

test("loads a packaged layout independent of container cwd", () => {
  const tree = temporaryLayoutTree();
  try {
    const loaded = loadFlashLayout({
      env: { NODE_ENV: "production", FARMOS_FLASH_LAYOUT_PATH: tree.layoutPath },
      moduleDir: path.join(tree.appDir, "dist", "config"),
      cwd: "/tmp/unrelated-cwd",
    });
    assert.equal(loaded.layoutId, "TEST_LAYOUT");
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test("fails closed when the configured layout is missing", () => {
  const tree = temporaryLayoutTree();
  try {
    assert.throws(
      () => loadFlashLayout({
        env: { NODE_ENV: "production", FARMOS_FLASH_LAYOUT_PATH: path.join(tree.firmwareDir, "missing.json"), FARMOS_FLASH_LAYOUT_DIR: tree.firmwareDir },
        moduleDir: path.join(tree.appDir, "dist", "config"),
        cwd: tree.appDir,
      }),
      /unavailable or unsafe/,
    );
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test("rejects a symlink that escapes the configured mount", () => {
  const tree = temporaryLayoutTree();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "farmos-flash-layout-outside-"));
  const outsidePath = path.join(outsideDir, "flash_layout.json");
  fs.writeFileSync(outsidePath, JSON.stringify(validLayout()));
  try {
    fs.unlinkSync(tree.layoutPath);
    fs.symlinkSync(outsidePath, tree.layoutPath);
    assert.throws(
      () => loadFlashLayout({
        env: { NODE_ENV: "production", FARMOS_FLASH_LAYOUT_PATH: tree.layoutPath, FARMOS_FLASH_LAYOUT_DIR: tree.firmwareDir },
        moduleDir: path.join(tree.appDir, "dist", "config"),
        cwd: tree.appDir,
      }),
      /unavailable or unsafe/,
    );
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
