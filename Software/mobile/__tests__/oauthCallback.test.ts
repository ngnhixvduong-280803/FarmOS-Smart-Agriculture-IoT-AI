import { oauthCode } from "../src/services/oauthCallback";

test("extracts only the authorization code for PKCE exchange", () => {
  expect(oauthCode("farmos://auth/callback?code=test-code")).toBe("test-code");
});
test.each([
  "https://auth/callback?code=x",
  "farmos://evil/callback?code=x",
  "farmos://auth/callback-evil?code=x",
  "farmos://auth/callback#error=denied",
  "farmos://auth/callback?code=x&error=denied",
])("rejects invalid callback %s", url => {
  expect(() => oauthCode(url)).toThrow();
});
