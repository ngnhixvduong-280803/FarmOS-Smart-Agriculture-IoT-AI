import {
  LEAF_PAIRING_TIMEOUT_MS,
  OnboardingCancelledError,
  OnboardingStatusFailedError,
  OnboardingStatusTimeoutError,
  isRetryableOnboardingError,
  pollOnboardingStatus,
} from "../src/services/onboardingStatus";

type Status = { status: string; failure_reason?: string };

function testPoll(fetchStatus: () => Promise<Status>, timeoutMs = 1_000) {
  let clock = 0;
  return pollOnboardingStatus(
    fetchStatus,
    {
      timeoutMs,
      intervalMs: 100,
      now: () => clock,
      sleep: async (delayMs) => { clock += delayMs; },
    },
    (result) => result.status === "REDEEMED" || result.status === "ACTIVE",
    ["FAILED", "EXPIRED", "CANCELLED"],
  );
}

describe("onboarding server status polling", () => {
  it("allows a slow Gateway to confirm pairing after the former 35-second deadline", async () => {
    let elapsed = 0;
    const result = await pollOnboardingStatus(
      async () => ({ status: elapsed >= 40_000 ? "ACTIVE" : "GATEWAY_READY" }),
      {
        timeoutMs: LEAF_PAIRING_TIMEOUT_MS,
        intervalMs: 2_000,
        now: () => elapsed,
        sleep: async (delayMs) => { elapsed += delayMs; },
      },
      (status) => status.status === "ACTIVE",
      ["FAILED", "EXPIRED", "CANCELLED"],
    );
    expect(result.status).toBe("ACTIVE");
    expect(elapsed).toBe(40_000);
  });
  it("does not resolve after BLE write until the cloud session is REDEEMED", async () => {
    const statuses: Status[] = [{ status: "PENDING" }, { status: "PENDING" }, { status: "REDEEMED" }];
    const fetchStatus = jest.fn(async () => statuses.shift() || { status: "PENDING" });

    await expect(testPoll(fetchStatus)).resolves.toEqual({ status: "REDEEMED" });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("surfaces a server terminal failure instead of showing success", async () => {
    const fetchStatus = jest.fn()
      .mockResolvedValueOnce({ status: "GATEWAY_READY" })
      .mockResolvedValueOnce({ status: "FAILED", failure_reason: "radio timeout" });

    await expect(testPoll(fetchStatus)).rejects.toMatchObject({
      name: OnboardingStatusFailedError.name,
      status: "FAILED",
      message: "radio timeout",
    });
  });

  it("times out with a bounded error while the server remains pending", async () => {
    const fetchStatus = jest.fn().mockResolvedValue({ status: "PENDING" });

    await expect(testPoll(fetchStatus, 250)).rejects.toBeInstanceOf(OnboardingStatusTimeoutError);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("bounds a status request that never resolves", async () => {
    const fetchStatus = jest.fn(() => new Promise<Status>(() => undefined));
    await expect(pollOnboardingStatus(
      fetchStatus,
      { timeoutMs: 20, intervalMs: 5 },
      (result) => result.status === "REDEEMED",
      ["FAILED", "EXPIRED", "CANCELLED"],
    )).rejects.toBeInstanceOf(OnboardingStatusTimeoutError);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("cancels polling and does not issue another status request", async () => {
    const controller = new AbortController();
    const fetchStatus = jest.fn(async () => {
      controller.abort();
      return { status: "PENDING" };
    });
    const onStateChange = jest.fn();

    await expect(pollOnboardingStatus(
      fetchStatus,
      {
        timeoutMs: 1_000,
        intervalMs: 100,
        signal: controller.signal,
        sleep: async () => undefined,
        onStateChange,
      },
      (result) => result.status === "REDEEMED",
      ["FAILED", "EXPIRED", "CANCELLED"],
    )).rejects.toBeInstanceOf(OnboardingCancelledError);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("CANCELLED");
  });

  it("retries a transient status request without treating it as success", async () => {
    let clock = 0;
    const states: Status[] = [{ status: "PENDING" }, { status: "REDEEMED" }];
    const fetchStatus = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error("request timeout"), { code: "REQUEST_TIMEOUT" }))
      .mockImplementation(async (_signal?: AbortSignal, timeoutMs?: number) => {
        expect(timeoutMs).toBeGreaterThan(0);
        return states.shift() || { status: "PENDING" };
      });
    const onStateChange = jest.fn();

    await expect(pollOnboardingStatus(
      fetchStatus,
      {
        timeoutMs: 1_000,
        intervalMs: 100,
        now: () => clock,
        sleep: async (delayMs) => { clock += delayMs; },
        retryOnError: isRetryableOnboardingError,
        onStateChange,
      },
      (result) => result.status === "REDEEMED",
      ["FAILED", "EXPIRED", "CANCELLED"],
    )).resolves.toEqual({ status: "REDEEMED" });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(onStateChange).toHaveBeenCalledWith("RETRYING");
    expect(onStateChange).toHaveBeenCalledWith("PENDING", { status: "PENDING" });
  });

  it("does not retry an actionable API failure", async () => {
    const error = new Error("Không tìm thấy phiên cài đặt");
    const fetchStatus = jest.fn().mockRejectedValue(error);
    await expect(pollOnboardingStatus(
      fetchStatus,
      { timeoutMs: 1_000, retryOnError: isRetryableOnboardingError },
      (result) => result.status === "REDEEMED",
      ["FAILED", "EXPIRED", "CANCELLED"],
    )).rejects.toBe(error);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });
});
