import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  buildPublicConfig,
  normalizePublicUrl,
  preparePublicConfig,
  renderPublicConfig,
} from "./prepare-public-config.mjs";

const PUBLIC_ENV = [
  "FARMOS_API_URL=https://api.example.test/",
  "FARMOS_WEB_URL=\"https://app.example.test\"",
  "SUPABASE_URL=https://project.supabase.co/",
  "SUPABASE_ANON_KEY=public-anon-key",
].join("\n");

test("normalizes canonical origins and rejects telemetry route hacks", () => {
  assert.equal(normalizePublicUrl("https://api.example.test/", "FARMOS_API_URL"), "https://api.example.test");
  assert.equal(normalizePublicUrl("http://localhost:5001", "FARMOS_API_URL"), "http://localhost:5001");
  assert.throws(
    () => normalizePublicUrl("https://api.example.test/api/v1/telemetry", "FARMOS_API_URL"),
    /origin URL without a path/,
  );
  assert.throws(() => normalizePublicUrl("https://user:pass@example.test", "FARMOS_API_URL"), /without credentials/);
});

test("missing public configuration fails with canonical names", () => {
  assert.throws(
    () => buildPublicConfig("FARMOS_API_URL=https://api.example.test\n"),
    /FARMOS_WEB_URL/,
  );
});

test("legacy URL aliases normalize into canonical client origins", () => {
  const legacy = [
    "BACKEND_API_URL=https://api.example.test/api/v1/telemetry",
    "DOMAIN=https://app.example.test/",
    "SUPABASE_URL=https://project.supabase.co",
    "SUPABASE_ANON_KEY=public-anon-key",
  ].join("\n");
  const built = buildPublicConfig(legacy);
  assert.equal(built.config.apiBaseUrl, "https://api.example.test");
  assert.equal(built.config.webBaseUrl, "https://app.example.test");
  assert.deepEqual(built.warnings, [
    "BACKEND_API_URL is deprecated; use FARMOS_API_URL",
    "DOMAIN is deprecated; use FARMOS_WEB_URL",
  ]);
  assert.doesNotMatch(renderPublicConfig(built), /BACKEND_API_URL|DOMAIN/);
});

test("source hash and generated output never include server-only values", () => {
  const withSecret = `${PUBLIC_ENV}\nJWT_SECRET=server-only-sentinel\nSUPABASE_SERVICE_ROLE_KEY=service-role-sentinel\n`;
  const changedSecret = withSecret.replace("server-only-sentinel", "another-server-only-sentinel");
  const first = buildPublicConfig(withSecret);
  const second = buildPublicConfig(changedSecret);
  const rendered = renderPublicConfig(first);

  assert.equal(first.sourceHash, second.sourceHash);
  assert.doesNotMatch(rendered, /server-only-sentinel|service-role-sentinel|JWT_SECRET|SERVICE_ROLE/);
  assert.match(rendered, /apiBaseUrl/);
  assert.match(rendered, /webBaseUrl/);
  assert.match(rendered, /PUBLIC_CONFIG_SOURCE_HASH/);
});

test("prepare writes a fresh file and check mode rejects stale output", () => {
  const directory = mkdtempSync(join(tmpdir(), "farmos-public-config-"));
  const envPath = join(directory, ".env");
  const outputPath = join(directory, "generated-config.ts");
  try {
    writeFileSync(envPath, PUBLIC_ENV);
    preparePublicConfig({ rootEnvPath: envPath, outputPath });
    assert.doesNotThrow(() => preparePublicConfig({ rootEnvPath: envPath, outputPath, check: true }));
    writeFileSync(envPath, PUBLIC_ENV.replace("app.example.test", "new-app.example.test"));
    assert.throws(
      () => preparePublicConfig({ rootEnvPath: envPath, outputPath, check: true }),
      /đã cũ/,
    );
    assert.match(readFileSync(outputPath, "utf8"), /api\.example\.test/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native build paths depend on public config generation", () => {
  const gradle = readFileSync(resolve(import.meta.dirname, "../android/app/build.gradle"), "utf8");
  const xcode = readFileSync(resolve(import.meta.dirname, "../ios/FarmOSMobile.xcodeproj/project.pbxproj"), "utf8");
  assert.match(gradle, /preparePublicConfig/);
  assert.match(gradle, /preBuild/);
  assert.match(xcode, /Prepare FarmOS public config/);
  assert.match(xcode, /prepare-public-config\.mjs/);
  assert.match(xcode, /Bundle React Native code and images/);
});
