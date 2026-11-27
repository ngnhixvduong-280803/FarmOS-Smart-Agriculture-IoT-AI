export const CLOUD_PROVISIONING_TIMEOUT_MS = 60_000;
// Allow Gateway network recovery and multiple LoRa retries within the 5-minute grant.
export const LEAF_PAIRING_TIMEOUT_MS = 120_000;
export const ONBOARDING_STATUS_POLL_INTERVAL_MS = 2_000;

export type OnboardingStatusRecord = { status: string; failure_reason?: unknown };

export class OnboardingStatusTimeoutError extends Error {
  readonly code = "ONBOARDING_STATUS_TIMEOUT";

  constructor(message = "Thiết bị chưa xác nhận trạng thái trong thời gian cho phép") {
    super(message);
    this.name = "OnboardingStatusTimeoutError";
  }
}

export class OnboardingStatusFailedError extends Error {
  readonly code = "ONBOARDING_STATUS_FAILED";
  readonly status: string;

  constructor(status: string, message?: string) {
    super(message || `Thiết bị chưa hoàn tất provisioning (${status})`);
    this.name = "OnboardingStatusFailedError";
    this.status = status;
  }
}

export class OnboardingCancelledError extends Error {
  readonly code = "ONBOARDING_CANCELLED";

  constructor() {
    super("Onboarding đã bị hủy");
    this.name = "OnboardingCancelledError";
  }
}

export type OnboardingPollState = "PENDING" | "RETRYING" | "SUCCEEDED" | "FAILED" | "TIMEOUT" | "CANCELLED";

export interface PollOnboardingStatusOptions {
  timeoutMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  /** Retry only transport failures; server terminal statuses are never retried. */
  retryOnError?: (error: unknown) => boolean;
  onStateChange?: (state: OnboardingPollState, value?: OnboardingStatusRecord) => void;
}

export function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new OnboardingCancelledError());
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new OnboardingCancelledError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, delayMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchStatusWithinDeadline<T extends OnboardingStatusRecord>(
  fetchStatus: (signal?: AbortSignal, timeoutMs?: number) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted) throw new OnboardingCancelledError();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let rejectExternalAbort: ((reason?: unknown) => void) | undefined;
  const externalAbort = signal
    ? new Promise<never>((_, reject) => { rejectExternalAbort = reject; })
    : undefined;

  if (signal) {
    const onAbort = () => {
      controller.abort();
      rejectExternalAbort?.(new OnboardingCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  }

  const operation = fetchStatus(controller.signal, timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new OnboardingStatusTimeoutError());
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race(externalAbort ? [operation, deadline, externalAbort] : [operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbortListener?.();
    operation.catch(() => undefined);
  }
}

/**
 * Poll a server-owned onboarding status. BLE write success is deliberately not
 * treated as onboarding success; only the server's terminal success status is.
 */
export async function pollOnboardingStatus<T extends OnboardingStatusRecord>(
  // The second argument lets API callers cap each request by the remaining
  // overall deadline. Existing one-argument callbacks remain compatible.
  fetchStatus: (signal?: AbortSignal, timeoutMs?: number) => Promise<T>,
  options: PollOnboardingStatusOptions,
  isSuccess: (value: T) => boolean,
  terminalFailureStatuses: readonly string[],
): Promise<T> {
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || sleepWithAbort;
  const intervalMs = Math.max(0, options.intervalMs ?? ONBOARDING_STATUS_POLL_INTERVAL_MS);
  const deadline = now() + Math.max(0, options.timeoutMs);
  let firstRequest = true;
  let cancellationNotified = false;
  const throwIfCancelled = () => {
    if (options.signal?.aborted) {
      if (!cancellationNotified) {
        cancellationNotified = true;
        options.onStateChange?.("CANCELLED");
      }
      throw new OnboardingCancelledError();
    }
  };

  while (true) {
    throwIfCancelled();
    const remainingBeforeRequest = deadline - now();
    if (!firstRequest && remainingBeforeRequest <= 0) {
      options.onStateChange?.("TIMEOUT");
      throw new OnboardingStatusTimeoutError();
    }
    firstRequest = false;

    let result: T;
    try {
      // Keep the total wait bounded even when fetch ignores AbortController.
      // A minimum of 1ms preserves the immediate first status request while
      // ensuring the per-request timeout is never zero.
      result = await fetchStatusWithinDeadline(fetchStatus, options.signal, Math.max(1, remainingBeforeRequest));
    } catch (error) {
      throwIfCancelled();
      if (!options.retryOnError?.(error)) throw error;
      if (deadline - now() <= 0) {
        options.onStateChange?.("TIMEOUT");
        throw new OnboardingStatusTimeoutError();
      }
      options.onStateChange?.("RETRYING");
      const remaining = deadline - now();
      await sleep(Math.min(intervalMs, remaining), options.signal);
      continue;
    }

    throwIfCancelled();
    if (isSuccess(result)) {
      options.onStateChange?.("SUCCEEDED", result);
      return result;
    }
    if (terminalFailureStatuses.includes(result.status)) {
      const reason = typeof result.failure_reason === "string" ? result.failure_reason : undefined;
      options.onStateChange?.("FAILED", result);
      throw new OnboardingStatusFailedError(result.status, reason);
    }

    options.onStateChange?.("PENDING", result);
    const remaining = deadline - now();
    if (remaining <= 0) {
      options.onStateChange?.("TIMEOUT");
      throw new OnboardingStatusTimeoutError();
    }
    await sleep(Math.min(intervalMs, remaining), options.signal);
  }
}

export function isAbortLikeError(error: unknown): boolean {
  return error instanceof OnboardingCancelledError ||
    (error instanceof Error && error.name === "AbortError");
}

/**
 * Fetch/network failures can be retried while the server-owned session stays
 * pending. HTTP/API errors are intentionally not included: a 4xx response is
 * actionable and should be surfaced immediately instead of being hidden until
 * the overall timeout.
 */
export function isRetryableOnboardingError(error: unknown): boolean {
  if (!(error instanceof Error) || isAbortLikeError(error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (code === "REQUEST_TIMEOUT") return true;
  return error.name === "TypeError" && /network|fetch|connection|timeout/i.test(error.message);
}
