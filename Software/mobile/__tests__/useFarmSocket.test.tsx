import React, { useEffect } from "react";
import ReactTestRenderer from "react-test-renderer";

const mockHandlers = new Map<string, () => void>();
const mockDisconnect = jest.fn();

jest.mock("socket.io-client", () => ({
  io: jest.fn(() => ({
    on: jest.fn((event: string, handler: () => void) => {
      mockHandlers.set(event, handler);
    }),
    disconnect: mockDisconnect,
  })),
}));

import { SOCKET_REFRESH_DEBOUNCE_MS, useFarmSocket } from "../src/hooks/useFarmSocket";

function Harness({ onChange }: { onChange: () => void | Promise<void> }) {
  useFarmSocket("mobile-token", onChange);
  useEffect(() => undefined, []);
  return null;
}

describe("useFarmSocket", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockHandlers.clear();
    mockDisconnect.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("coalesces a burst of realtime events into one refresh", async () => {
    const onChange = jest.fn().mockResolvedValue(undefined);
    let renderer: ReactTestRenderer.ReactTestRenderer;

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<Harness onChange={onChange} />);
    });

    mockHandlers.get("telemetry:update")?.();
    mockHandlers.get("gateway:status")?.();
    mockHandlers.get("irrigation:status")?.();
    mockHandlers.get("alert:new")?.();
    expect(onChange).not.toHaveBeenCalled();

    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(SOCKET_REFRESH_DEBOUNCE_MS);
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(async () => {
      renderer!.unmount();
    });
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
