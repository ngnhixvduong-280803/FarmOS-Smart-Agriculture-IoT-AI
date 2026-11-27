jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" },
  getGenericPassword: jest.fn().mockResolvedValue(false),
  setGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(false),
}));
jest.mock("@swan-io/react-native-browser", () => ({
  openBrowser: jest.fn().mockResolvedValue(undefined),
  closeBrowser: jest.fn().mockResolvedValue(undefined),
}));

import {
  ApiTimeoutError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FIRMWARE_DOWNLOAD_TIMEOUT_MS,
  api,
  request,
  setAccessToken,
} from "../src/services/api";

describe("mobile API timeouts", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test("aborts a request and reports a clear timeout error", async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = jest.fn((_input, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;

    const pending = api.farms();
    const pendingError = pending.catch((error) => error);
    await jest.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);

    expect(await pendingError).toMatchObject({
      name: "ApiTimeoutError",
      code: "REQUEST_TIMEOUT",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    } satisfies Partial<ApiTimeoutError>);
    expect(requestSignal?.aborted).toBe(true);
  });

  test("uses a longer timeout for firmware downloads", async () => {
    globalThis.fetch = jest.fn(() => new Promise<Response>(() => undefined)) as typeof fetch;

    const pending = api.downloadFirmwareBinary("/storage/firmware.bin");
    const pendingError = pending.catch((error) => error);
    await jest.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS + 1);
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await jest.advanceTimersByTimeAsync(FIRMWARE_DOWNLOAD_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS);
    expect(await pendingError).toMatchObject({
      name: "ApiTimeoutError",
      timeoutMs: FIRMWARE_DOWNLOAD_TIMEOUT_MS,
    });
  });

  test("uses the protected admin inventory endpoint for factory-board records", async () => {
    globalThis.fetch = jest.fn((_url: string, _init?: RequestInit) => Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    } as Response)) as typeof fetch;
    setAccessToken("admin-mobile-token");

    await expect(api.adminDevices()).resolves.toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/admin/devices"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer admin-mobile-token" }) }),
    );
  });

  test("rejects immediately when the caller aborts", async () => {
    globalThis.fetch = jest.fn(() => new Promise<Response>(() => undefined)) as typeof fetch;
    const controller = new AbortController();
    const pending = request("/farms", {}, { signal: controller.signal });
    const pendingError = pending.catch((error) => error);

    controller.abort();

    expect(await pendingError).toMatchObject({ name: "AbortError" });
  });

  test("silently refreshes token and retries on 401", async () => {
    const supabaseModule = require("../src/services/supabase");
    jest.spyOn(supabaseModule, "getFreshIdentityToken").mockResolvedValue("mock-fresh-supabase-token");

    let callCount = 0;
    globalThis.fetch = jest.fn((url: string, init?: RequestInit) => {
      callCount++;
      const urlStr = String(url);
      if (urlStr.includes("/farms")) {
        if (callCount === 1) {
          // First attempt returns 401
          return Promise.resolve({
            status: 401,
            ok: false,
            json: () => Promise.resolve({ success: false, error: "Session expired" }),
          } as Response);
        }
        // Retry with refreshed token succeeds
        expect(init?.headers).toMatchObject({ Authorization: "Bearer new-exchanged-mobile-token" });
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ success: true, data: [{ id: "farm-1", name: "Farm 1" }] }),
        } as Response);
      }
      if (urlStr.includes("/auth/mobile/session")) {
        // Token exchange endpoint
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ success: true, data: { accessToken: "new-exchanged-mobile-token" } }),
        } as Response);
      }
      return Promise.reject(new Error("Unexpected endpoint"));
    }) as typeof fetch;

    setAccessToken("old-expired-token");
    const farms = await api.farms();
    expect(farms).toEqual([{ id: "farm-1", name: "Farm 1" }]);
  });
});
