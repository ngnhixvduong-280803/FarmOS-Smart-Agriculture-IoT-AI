import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { getSessionFromRequest } from "../api/middleware/auth.middleware";

test("WebSocket authentication reads a mobile bearer from plain Node headers", () => {
  const token = jwt.sign(
    { id: "user-websocket", email: "socket@example.com", role: "USER" },
    env.JWT_SECRET,
    {
      algorithm: "HS256",
      issuer: env.JWT_ISSUER,
      audience: env.MOBILE_JWT_AUDIENCE,
      expiresIn: "5m",
    },
  );

  const session = getSessionFromRequest({
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(session?.id, "user-websocket");
  assert.equal(session?.email, "socket@example.com");
});

test("WebSocket authentication reads a browser session from plain cookie headers", () => {
  const token = jwt.sign(
    { id: "user-browser", email: "browser@example.com", role: "USER", csrf: "csrf-token" },
    env.JWT_SECRET,
    {
      algorithm: "HS256",
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: "5m",
    },
  );

  const session = getSessionFromRequest({
    headers: { cookie: `another=value; ${env.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
  });

  assert.equal(session?.id, "user-browser");
  assert.equal(session?.csrf, "csrf-token");
});
