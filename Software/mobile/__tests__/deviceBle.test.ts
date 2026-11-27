jest.mock("react-native-ble-plx", () => ({
  BleManager: jest.fn(),
  State: {
    Unknown: "Unknown",
    Resetting: "Resetting",
    Unsupported: "Unsupported",
    Unauthorized: "Unauthorized",
    PoweredOff: "PoweredOff",
    PoweredOn: "PoweredOn",
  },
}));

import { BleManager } from "react-native-ble-plx";
import { assertBleIdentityMatchesExpected, BleProvisioningSecurityError, bleProvisioningSecurityInstructions, calculateOtaChunkSize, ensureSecureBleLink, GATEWAY_AUTH_UUID, GATEWAY_SERVICE_UUID, isBleSecurityError, NODE_AUTH_UUID, NODE_PAIRING_UUID, NODE_SERVICE_UUID, provisionAttestedExistingDevice } from "../src/services/deviceBle";

const { Buffer } = jest.requireActual("node:buffer");

describe("BLE OTA chunk sizing", () => {
  it("uses the ATT payload for the exposed MTU", () => {
    expect(calculateOtaChunkSize(23)).toBe(20);
    expect(calculateOtaChunkSize(247)).toBe(240);
  });

  it("caps large Android MTUs and falls back safely for iOS/default values", () => {
    expect(calculateOtaChunkSize(512)).toBe(240);
    expect(calculateOtaChunkSize(undefined)).toBe(20);
    expect(calculateOtaChunkSize(null)).toBe(20);
  });
});

describe("BLE provisioning security errors", () => {
  it("binds a mode transition to the stored identity without needing a QR", () => {
    expect(() => assertBleIdentityMatchesExpected({
      version: 3,
      type: "SENSOR_NODE",
      id: "NODE_42",
      serialNumber: "SN-42",
      hardwareRevision: "REV_A",
      attestationPublicKey: "p256-key",
    }, {
      deviceId: "NODE_42",
      type: "SENSOR_NODE",
      serialNumber: "SN-42",
      hardwareRevision: "REV_A",
    })).not.toThrow();
    expect(() => assertBleIdentityMatchesExpected({
      version: 3,
      type: "SENSOR_NODE",
      id: "NODE_42",
      serialNumber: "SN-42",
      hardwareRevision: "REV_A",
      attestationPublicKey: "p256-key",
    }, {
      deviceId: "NODE_42",
      type: "SENSOR_NODE",
      serialNumber: "SN-43",
      hardwareRevision: "REV_A",
    })).toThrow(/Serial/);
  });

  it("recognizes native encryption/authentication failures", () => {
    expect(isBleSecurityError({ attErrorCode: 15 })).toBe(true);
    expect(isBleSecurityError({ androidErrorCode: 0x8e })).toBe(true);
    expect(isBleSecurityError(new Error("GATT link is not encrypted"))).toBe(true);
    expect(isBleSecurityError(new Error("characteristic write failed"))).toBe(false);
  });

  it("provides platform guidance as a hard provisioning error", () => {
    const error = new BleProvisioningSecurityError();
    expect(error.code).toBe("BLE_PROVISIONING_SECURITY");
    expect(error.message).toBe(bleProvisioningSecurityInstructions());
  });

  it("requires a protected auth characteristic before provisioning", async () => {
    const device = {
      characteristicsForService: jest.fn().mockResolvedValue([{ uuid: NODE_AUTH_UUID, isReadable: true }]),
      readCharacteristicForService: jest.fn().mockResolvedValue({ value: null }),
    };

    await expect(ensureSecureBleLink(device as never, "SENSOR_NODE")).resolves.toBeUndefined();
    expect(device.characteristicsForService).toHaveBeenCalledWith(NODE_SERVICE_UUID);
    expect(device.readCharacteristicForService).toHaveBeenCalledWith(NODE_SERVICE_UUID, NODE_AUTH_UUID);
  });

  it("keeps iOS connected when the protected read initially returns ATT 5", async () => {
    jest.useFakeTimers();
    try {
      const device = {
        characteristicsForService: jest.fn().mockResolvedValue([{ uuid: NODE_AUTH_UUID, isReadable: true }]),
        readCharacteristicForService: jest.fn()
          .mockRejectedValueOnce({ attErrorCode: 5 })
          .mockResolvedValueOnce({ value: null }),
      };
      const verified = ensureSecureBleLink(device as never, "SENSOR_NODE");
      await jest.runAllTimersAsync();
      await expect(verified).resolves.toBeUndefined();
      expect(device.readCharacteristicForService).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("fails closed when the device has no secure pairing capability", async () => {
    const device = {
      characteristicsForService: jest.fn().mockResolvedValue([]),
      readCharacteristicForService: jest.fn(),
    };

    await expect(ensureSecureBleLink(device as never, "GATEWAY")).rejects.toBeInstanceOf(BleProvisioningSecurityError);
    expect(device.characteristicsForService).toHaveBeenCalledWith(GATEWAY_SERVICE_UUID);
    expect(device.readCharacteristicForService).not.toHaveBeenCalled();
  });

  it("turns native unencrypted-link rejection into pairing guidance", async () => {
    const device = {
      characteristicsForService: jest.fn().mockResolvedValue([{ uuid: GATEWAY_AUTH_UUID, isReadable: true }]),
      readCharacteristicForService: jest.fn().mockRejectedValue({ iosErrorCode: 0x8e }),
    };

    await expect(ensureSecureBleLink(device as never, "GATEWAY")).rejects.toMatchObject({
      code: "BLE_PROVISIONING_SECURITY",
      name: "BleProvisioningSecurityError",
    });
  });
});

it("writes Wi-Fi changes as UTF-8 JSON over the protected BLE channel", async () => {
  const identity = {
    version: 3, type: "SENSOR_NODE" as const, id: "NODE_42", serialNumber: "SN-42",
    hardwareRevision: "REV_A", attestationPublicKey: "p256-key",
  };
  const write = jest.fn();
  const device = {
    discoverAllServicesAndCharacteristics: jest.fn().mockImplementation(async () => device),
    characteristicsForService: jest.fn().mockResolvedValue([{ uuid: NODE_AUTH_UUID, isReadable: true }]),
    readCharacteristicForService: jest.fn()
      .mockResolvedValueOnce({ value: null })
      .mockResolvedValueOnce({ value: Buffer.from(JSON.stringify(identity)).toString("base64") }),
    writeCharacteristicWithResponseForService: write,
    cancelConnection: jest.fn().mockResolvedValue(undefined),
  };
  jest.mocked(BleManager).mockImplementationOnce(() => ({
    connectToDevice: jest.fn().mockResolvedValue(device),
  }) as never);
  const ssid = "Vườn ươm 🌱 50%";
  const password = "café-test%42";
  await provisionAttestedExistingDevice({ bleId: "test", name: "Test Node", type: "SENSOR_NODE" }, {
    deviceId: identity.id, type: identity.type, serialNumber: identity.serialNumber, hardwareRevision: identity.hardwareRevision,
  }, {
    deploymentMode: "STANDALONE_NODE", ssid, password, apiBaseUrl: "https://example.test",
    sessionId: "session", provisioningToken: "token", signature: "signature",
  });
  expect(write).toHaveBeenCalledTimes(1);
  const [service, characteristic, encoded] = write.mock.calls[0];
  expect([service, characteristic]).toEqual([NODE_SERVICE_UUID, NODE_PAIRING_UUID]);
  expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toMatchObject({ ssid, password, deviceId: identity.id });
  expect(device.cancelConnection).toHaveBeenCalledTimes(1);
});
