import { prisma } from "../database/prisma";
import { safetyEngine, IrrigationRequest } from "./safety.service";
import { publishMqttMessageConfirmed } from "../mqtt/mqtt.client";
import { env } from "../config/env";
import { broadcastAlert, broadcastIrrigationStatus } from "../websocket/socket.server";

export interface DispatchResult {
  success: boolean;
  commandId?: string;
  message: string;
  durationSec?: number;
  statusCode?: number;
}

class CommandDispatcher {
  private timeoutTimers: Map<string, NodeJS.Timeout> = new Map();

  // Phát lệnh tưới an toàn
  public async dispatchIrrigation(req: IrrigationRequest): Promise<DispatchResult> {
    const { farmId, zoneId, valveId = "V01", triggerSource, reason } = req;

    if (!env.IRRIGATION_CONTROL_ENABLED) {
      return {
        success: false,
        message: "Điều khiển tưới đang bị khóa: Gateway/relay/interlock vật lý chưa được phát hành và xác minh.",
        statusCode: 503,
      };
    }

    // 1. Kiểm tra qua Safety Engine
    const validation = await safetyEngine.validateIrrigationRequest(req);
    if (!validation.allowed || !validation.commandId) {
      return {
        success: false,
        message: validation.reason || "Lệnh bị từ chối bởi Safety Engine",
        statusCode: 409,
      };
    }

    const { commandId, clampedDurationSec } = validation;

    try {
      // 2. Tạo bản ghi IrrigationLog với trạng thái EXECUTING
      await prisma.irrigationLog.create({
        data: {
          command_id: commandId,
          zone_id: zoneId,
          valve_id: valveId,
          duration_sec: clampedDurationSec,
          trigger_source: triggerSource,
          status: "EXECUTING",
          safety_checks_passed: true,
        },
      });

      // 3. Đóng gói payload MQTT
      const topic = `farm/${farmId}/zone/${zoneId}/command`;
      const payload = {
        commandId,
        action: "irrigate",
        duration_sec: clampedDurationSec,
        valve_id: valveId,
        policy_version: "v2",
        timestamp: Math.floor(Date.now() / 1000),
      };

      // 4. Phát lệnh lên MQTT Broker
      if (!(await publishMqttMessageConfirmed(topic, payload))) {
        throw new Error("MQTT Broker chưa xác nhận lệnh tưới; không đánh dấu lệnh đang thực thi");
      }
      console.log(`📤 [DISPATCHER] Đã phát lệnh ${commandId} tới topic: ${topic} (${clampedDurationSec}s)`);

      // Thông báo qua WebSocket
      broadcastIrrigationStatus({
        farmId,
        commandId,
        zoneId,
        status: "EXECUTING",
        timestamp: Date.now(),
      });

      // 5. Cài đặt Timeout Timer chờ ACK
      const totalTimeoutMs = (clampedDurationSec + env.SAFETY_ACK_TIMEOUT_SEC) * 1000;
      const timer = setTimeout(() => {
        this.handleCommandTimeout(commandId, zoneId, farmId);
      }, totalTimeoutMs);

      this.timeoutTimers.set(commandId, timer);

      return {
        success: true,
        commandId,
        durationSec: clampedDurationSec,
        message: `Đã cấp phép và gửi lệnh tưới cho ${zoneId} trong ${clampedDurationSec} giây.`,
      };
    } catch (e: any) {
      safetyEngine.releaseActiveIrrigation(commandId);
      console.error(`❌ [DISPATCHER] Lỗi khi phát lệnh tưới:`, e);
      // A broker callback can fail after the audit row was created. Never
      // leave that row as EXECUTING when no command was accepted for delivery.
      try {
        await prisma.irrigationLog.updateMany({
          where: { command_id: commandId, status: "EXECUTING" },
          data: {
            status: "FAILED",
            rejection_reason: "Không gửi được lệnh tới MQTT Broker.",
            completed_at: new Date(),
            error_code: 503,
          },
        });
      } catch (logError) {
        console.error("❌ [DISPATCHER] Không thể đánh dấu audit log dispatch thất bại:", logError);
      }
      broadcastIrrigationStatus({
        farmId,
        commandId,
        zoneId,
        status: "FAILED",
        timestamp: Date.now(),
      });
      return {
        success: false,
        message: "Không gửi được lệnh tưới tới Broker. Lệnh chưa được xác nhận thực thi.",
        statusCode: 503,
      };
    }
  }

  // Xử lý khi nhận được ACK hợp lệ từ Gateway
  public handleAckReceived(commandId: string, measuredFlowLiters: number, errorCode: number) {
    // Hủy timer timeout nếu còn
    const timer = this.timeoutTimers.get(commandId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(commandId);
    }

    // Giải phóng khóa an toàn trong Safety Engine
    safetyEngine.releaseActiveIrrigation(commandId);
  }

  // Xử lý khi quá hạn thời gian mà không nhận được ACK từ Gateway
  private async handleCommandTimeout(commandId: string, zoneId: string, farmId: string) {
    this.timeoutTimers.delete(commandId);
    safetyEngine.releaseActiveIrrigation(commandId);

    console.warn(`⏰ [DISPATCHER] TIMEOUT: Lệnh ${commandId} cho Zone ${zoneId} không nhận được ACK từ Gateway.`);

    try {
      // Cập nhật trạng thái log thành TIMEOUT
      await prisma.irrigationLog.updateMany({
        where: { command_id: commandId, status: "EXECUTING" },
        data: {
          status: "TIMEOUT",
          completed_at: new Date(),
          error_code: 408, // Request Timeout
        },
      });

      // Tạo cảnh báo mất phản hồi Gateway
      const alert = await prisma.alert.create({
        data: {
          farm_id: farmId,
          zone_id: zoneId,
          level: "WARNING",
          type: "COMMAND_TIMEOUT",
          message: `Lệnh tưới ${commandId} cho Zone ${zoneId} đã hết thời gian nhưng không nhận được ACK từ Gateway. Hãy kiểm tra kết nối LoRa/Wi-Fi.`,
        },
      });

      broadcastAlert({
        id: alert.id,
        farm_id: alert.farm_id,
        zone_id: alert.zone_id,
        level: alert.level,
        type: alert.type,
        message: alert.message,
        created_at: alert.created_at.toISOString(),
      });

      broadcastIrrigationStatus({
        farmId,
        commandId,
        zoneId,
        status: "TIMEOUT",
        timestamp: Date.now(),
      });
    } catch (e) {
      console.error("Lỗi khi xử lý command timeout:", e);
    }
  }

  // Lệnh dừng khẩn cấp toàn bộ van & bơm
  public async emergencyStop(farmId: string = "F01") {
    if (!env.IRRIGATION_CONTROL_ENABLED) {
      return {
        success: false,
        message: "Điều khiển tưới đang bị khóa: không thể xác nhận emergency stop trên phần cứng chưa được phát hành.",
        statusCode: 503,
      };
    }
    console.warn(`🚨 [DISPATCHER] KÍCH HOẠT DỪNG KHẨN CẤP (EMERGENCY STOP)!`);

    // Xóa tất cả các timer chờ
    for (const [cmdId, timer] of this.timeoutTimers.entries()) {
      clearTimeout(timer);
      safetyEngine.releaseActiveIrrigation(cmdId);
    }
    this.timeoutTimers.clear();

    // Phát lệnh dừng tới tất cả các Zone
    const stopTopics = [
      `farm/${farmId}/zone/Z01/command`,
      `farm/${farmId}/zone/Z02/command`,
      `farm/${farmId}/zone/Z03/command`,
      `farm/${farmId}/zone/ALL/command`,
    ];

    const payload = {
      commandId: `stop-all-${Date.now()}`,
      action: "stop",
      duration_sec: 0,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const published = await Promise.all(stopTopics.map((topic) => publishMqttMessageConfirmed(topic, payload)));
    if (published.some((result) => !result)) {
      return { success: false, message: "MQTT Broker chưa xác nhận đầy đủ lệnh dừng khẩn cấp.", statusCode: 503 };
    }

    // Cập nhật tất cả log đang EXECUTING thành FAILED (Emergency Aborted)
    await prisma.irrigationLog.updateMany({
      where: { status: "EXECUTING" },
      data: {
        status: "FAILED",
        rejection_reason: "Dừng khẩn cấp bởi người dùng (Emergency Stop)",
        completed_at: new Date(),
      },
    });

    return {
      success: true,
      message: "Đã gửi lệnh ngắt khẩn cấp toàn bộ van và bơm trên toàn trang trại.",
    };
  }
}

export const commandDispatcher = new CommandDispatcher();
