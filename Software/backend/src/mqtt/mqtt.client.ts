import mqtt, { MqttClient } from "mqtt";
import { env } from "../config/env";
import { handleTelemetryMessage } from "./handlers/telemetry.handler";
import { handleStatusMessage } from "./handlers/status.handler";
import { handleAckMessage } from "./handlers/ack.handler";

let client: MqttClient | null = null;

export function initMqttClient(options: { enableLegacyIngest?: boolean } = {}): MqttClient {
  console.log(`🔌 [MQTT] Đang kết nối tới MQTT Broker: ${env.MQTT_BROKER_URL}...`);

  client = mqtt.connect(env.MQTT_BROKER_URL, {
    clientId: `${env.MQTT_CLIENT_ID}_${Math.random().toString(16).substring(2, 8)}`,
    username: env.MQTT_USERNAME || undefined,
    password: env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
  });

  client.on("connect", () => {
    console.log(`✅ [MQTT] Kết nối thành công tới MQTT Broker!`);

    // Device-scoped HTTPS ingestion is the production path. MQTT ingestion is
    // a separately approved migration surface and must not be enabled merely
    // by configuring a broker connection.
    if (!options.enableLegacyIngest) {
      console.log("ℹ️ [MQTT] Legacy ingest subscriptions are disabled.");
      return;
    }

    // Subscribe các topic chính
    const topics = [
      "farm/+/node/+/telemetry",
      "farm/+/node/+/status",
      "farm/+/node/+/ack",
      "farm/+/gateway/+/node/+/telemetry",
    ];

    client?.subscribe(topics, (err) => {
      if (err) {
        console.error("❌ [MQTT] Lỗi khi subscribe topics:", err);
      } else {
        console.log(`📡 [MQTT] Đã subscribe thành công các topics:`, topics);
      }
    });
  });

  client.on("message", async (topic: string, message: Buffer) => {
    try {
      const payloadStr = message.toString();
      const payload = JSON.parse(payloadStr);

      // Legacy: farm/{farmId}/node/{nodeId}/{type}
      // Product: farm/{farmId}/gateway/{gatewayId}/node/{nodeId}/telemetry
      const parts = topic.split("/");
      if (parts.length < 5 || parts[0] !== "farm") {
        return;
      }

      const farmId = parts[1];
      const productTopic = parts.length === 7 && parts[2] === "gateway" && parts[4] === "node";
      const gatewayId = productTopic ? parts[3] : undefined;
      const nodeId = productTopic ? parts[5] : parts[3];
      const messageType = productTopic ? parts[6] : parts[4];

      switch (messageType) {
        case "telemetry":
          await handleTelemetryMessage(farmId, nodeId, payload, gatewayId);
          break;
        case "status":
          await handleStatusMessage(farmId, nodeId, payload);
          break;
        case "ack":
          await handleAckMessage(farmId, nodeId, payload);
          break;
        default:
        console.debug("[MQTT] Bỏ qua message loại: %s trên topic %s", messageType, topic);
      }
    } catch (e: any) {
      console.error("❌ [MQTT] Lỗi parse JSON trên topic %s:", topic, e.message);
    }
  });

  client.on("error", (err) => {
    console.error("❌ [MQTT] Lỗi kết nối MQTT:", err.message);
  });

  client.on("reconnect", () => {
    console.log("🔄 [MQTT] Đang thử kết nối lại...");
  });

  return client;
}

export function publishMqttMessage(topic: string, payload: any) {
  if (!client || !client.connected) {
    console.warn("⚠️ [MQTT] Không thể publish tới %s: Client chưa kết nối.", topic);
    return false;
  }

  const message = typeof payload === "string" ? payload : JSON.stringify(payload);
  client.publish(topic, message, { qos: 1 }, (err) => {
    if (err) {
      console.error("❌ [MQTT] Lỗi khi publish tới %s:", topic, err);
    }
  });
  return true;
}

/**
 * Resolve only after the broker has accepted the publish callback. Callers
 * that change a user-visible state (for example irrigation) must use this
 * instead of treating an unavailable client as a successful dispatch.
 */
export function publishMqttMessageConfirmed(topic: string, payload: any): Promise<boolean> {
  if (!client || !client.connected) {
    console.warn("⚠️ [MQTT] Không thể publish tới %s: Client chưa kết nối.", topic);
    return Promise.resolve(false);
  }
  const message = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Promise((resolve) => {
    client!.publish(topic, message, { qos: 1 }, (error) => {
      if (error) {
        console.error("❌ [MQTT] Lỗi khi publish tới %s:", topic, error);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

export function getMqttClient(): MqttClient | null {
  return client;
}
