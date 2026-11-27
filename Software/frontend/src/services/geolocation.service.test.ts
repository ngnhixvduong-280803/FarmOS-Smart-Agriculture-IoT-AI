import test from "node:test";
import assert from "node:assert/strict";
import {
  getFriendlyGpsErrorMessage,
  getCurrentPositionWithFallback,
} from "./geolocation.service.ts";

function setMockNavigator(mockGeo: any) {
  Object.defineProperty(globalThis, "navigator", {
    value: { geolocation: mockGeo },
    configurable: true,
    writable: true,
  });
}

test("getFriendlyGpsErrorMessage returns clear Vietnamese explanations", () => {
  assert.match(getFriendlyGpsErrorMessage({ code: 1 }), /từ chối quyền vị trí/i);
  assert.match(getFriendlyGpsErrorMessage({ code: 2 }), /Không thể xác định vị trí/i);
  assert.match(getFriendlyGpsErrorMessage({ code: 3 }), /Hết thời gian chờ GPS/i);
  assert.match(getFriendlyGpsErrorMessage({ code: -1 }), /không hỗ trợ/i);
});

test("getCurrentPositionWithFallback resolves immediately on high accuracy success", async () => {
  const mockCoords = {
    latitude: 10.8231,
    longitude: 106.6297,
    accuracy: 15,
    heading: 90,
    speed: 1,
    altitude: 10,
    altitudeAccuracy: 5,
  };

  setMockNavigator({
    getCurrentPosition: (success: any) => {
      success({ coords: mockCoords });
    },
  });

  const res = await getCurrentPositionWithFallback();
  assert.equal(res.latitude, 10.8231);
  assert.equal(res.longitude, 106.6297);
  assert.equal(res.isFallbackLowAccuracy, false);
});

test("getCurrentPositionWithFallback falls back to low accuracy on timeout", async () => {
  const mockLowCoords = {
    latitude: 10.8231,
    longitude: 106.6297,
    accuracy: 150,
    heading: null,
    speed: null,
    altitude: null,
    altitudeAccuracy: null,
  };

  let callCount = 0;
  setMockNavigator({
    getCurrentPosition: (success: any, error: any, options: any) => {
      callCount++;
      if (callCount === 1) {
        assert.equal(options.enableHighAccuracy, true);
        // Simulate code 3: TIMEOUT
        error({ code: 3, message: "Timeout expired" });
      } else {
        assert.equal(options.enableHighAccuracy, false);
        success({ coords: mockLowCoords });
      }
    },
  });

  const res = await getCurrentPositionWithFallback();
  assert.equal(callCount, 2);
  assert.equal(res.latitude, 10.8231);
  assert.equal(res.isFallbackLowAccuracy, true);
});

test("getCurrentPositionWithFallback rejects immediately on permission denied without falling back", async () => {
  let callCount = 0;
  setMockNavigator({
    getCurrentPosition: (_success: any, error: any) => {
      callCount++;
      error({ code: 1, message: "User denied Geolocation" });
    },
  });

  await assert.rejects(
    async () => {
      await getCurrentPositionWithFallback();
    },
    (err: any) => {
      assert.equal(err.code, 1);
      assert.match(err.message, /từ chối quyền vị trí/i);
      return true;
    }
  );

  assert.equal(callCount, 1);
});
