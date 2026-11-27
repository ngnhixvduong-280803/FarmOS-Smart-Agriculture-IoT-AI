import { prisma } from "../database/prisma";
import { env } from "../config/env";
import { v4 as uuidv4 } from "uuid";
import { broadcastAlert } from "../websocket/socket.server";

export interface WaterTankState {
  level_pct: number;
  safe: boolean;
  last_updated: Date;
}

export interface IrrigationRequest {
  farmId: string;
  zoneId: string;
  valveId?: string;
  durationSec: number;
  triggerSource: "MANUAL" | "SCHEDULE" | "AI";
  reason?: string;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  clampedDurationSec: number;
  commandId?: string;
}

class SafetyEngineService {
  private tankState: WaterTankState = {
    // No gateway heartbeat after a process restart is not evidence that there
    // is water. Keep the actuator path fail-closed until a complete, current
    // hardware interlock report arrives.
    level_pct: 0,
    safe: false,
    last_updated: new Date(0),
  };

  private activeIrrigationCommand: {
    commandId: string;
    zoneId: string;
    expiresAt: Date;
  } | null = null;

  // Cập nhật trạng thái bể nước từ Heartbeat/Status của Gateway
  public updateTankState(levelPct: number, isSafe: boolean) {
    this.tankState = {
      level_pct: levelPct,
      safe: isSafe,
      last_updated: new Date(),
    };

    // Nếu bể cạn đột ngột khi đang tưới -> có thể kích hoạt dừng khẩn cấp
    if (!isSafe || levelPct < env.SAFETY_MIN_WATER_TANK_PCT) {
      this.handleTankEmptyAlert();
    }
  }

  public getTankState(): WaterTankState {
    return { ...this.tankState };
  }

  public hasFreshTankState(nowMs = Date.now()): boolean {
    return this.tankState.last_updated.getTime() >= nowMs - env.SAFETY_TANK_STATUS_TTL_SEC * 1000;
  }

  // Xử lý cảnh báo bể cạn
  private async handleTankEmptyAlert() {
    console.warn(`⚠️ [SAFETY ENGINE] CẢNH BÁO: Bể nước không an toàn (Mức: ${this.tankState.level_pct}%, Safe: ${this.tankState.safe})`);
    
    // Tạo bản ghi alert trong database nếu chưa có alert chưa xử lý
    const existing = await prisma.alert.findFirst({
      where: {
        farm_id: "F01",
        type: "TANK_EMPTY",
        resolved: false,
      },
    });

    if (!existing) {
      const alert = await prisma.alert.create({
        data: {
          farm_id: "F01",
          level: "CRITICAL",
          type: "TANK_EMPTY",
          message: `Mực nước bể chứa quá thấp (${this.tankState.level_pct}%). Toàn bộ hoạt động tưới bị khóa an toàn!`,
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
    }
  }

  // Kiểm tra tính hợp lệ và an toàn của yêu cầu tưới (5 lớp bảo vệ)
  public async validateIrrigationRequest(req: IrrigationRequest): Promise<ValidationResult> {
    const { farmId, zoneId, durationSec, triggerSource } = req;

    // 1. Kiểm tra mực nước bể chứa (Water Tank Interlock)
    if (!this.hasFreshTankState()) {
      const reason = `Từ chối lệnh: chưa có heartbeat interlock bồn nước trong ${env.SAFETY_TANK_STATUS_TTL_SEC}s gần đây.`;
      await this.recordRejectedLog(farmId, zoneId, durationSec, triggerSource, reason);
      return { allowed: false, reason, clampedDurationSec: 0 };
    }
    if (!this.tankState.safe || this.tankState.level_pct < env.SAFETY_MIN_WATER_TANK_PCT) {
      const reason = `Từ chối lệnh: Bể nước dưới ngưỡng an toàn (${this.tankState.level_pct}% < ${env.SAFETY_MIN_WATER_TANK_PCT}%). Khóa chống cháy bơm kích hoạt!`;
      await this.recordRejectedLog(farmId, zoneId, durationSec, triggerSource, reason);
      return { allowed: false, reason, clampedDurationSec: 0 };
    }

    // 2. Kiểm tra xung đột van / Đang có vùng khác tưới (Interlock Busy Check)
    if (this.activeIrrigationCommand && new Date() < this.activeIrrigationCommand.expiresAt) {
      const reason = `Từ chối lệnh: Zone ${this.activeIrrigationCommand.zoneId} đang trong tiến trình tưới. Hệ thống khóa liên động không cho phép bật đồng thời nhiều van.`;
      await this.recordRejectedLog(farmId, zoneId, durationSec, triggerSource, reason);
      return { allowed: false, reason, clampedDurationSec: 0 };
    }

    // 3. Giới hạn thời gian tưới tối đa (Max Runtime Limit)
    let clampedDuration = durationSec;
    if (clampedDuration > env.SAFETY_MAX_RUNTIME_SEC) {
      console.warn(`⚠️ [SAFETY ENGINE] Yêu cầu ${clampedDuration}s vượt quá giới hạn tối đa. Đã ép về ${env.SAFETY_MAX_RUNTIME_SEC}s.`);
      clampedDuration = env.SAFETY_MAX_RUNTIME_SEC;
    }
    if (clampedDuration < 5) {
      clampedDuration = 5; // Tối thiểu 5 giây để van kịp mở và đóng
    }

    // 4. Sinh Command ID duy nhất & Đăng ký khóa chiếm dụng
    const commandId = `cmd-${Date.now()}-${uuidv4().substring(0, 5)}`;
    const expiresAt = new Date(Date.now() + (clampedDuration + 10) * 1000);

    this.activeIrrigationCommand = {
      commandId,
      zoneId,
      expiresAt,
    };

    return {
      allowed: true,
      clampedDurationSec: clampedDuration,
      commandId,
    };
  }

  // Giải phóng khóa khi nhận được ACK hoặc Timeout
  public releaseActiveIrrigation(commandId: string) {
    if (this.activeIrrigationCommand?.commandId === commandId) {
      this.activeIrrigationCommand = null;
      console.log(`🔓 [SAFETY ENGINE] Đã giải phóng khóa an toàn cho lệnh: ${commandId}`);
    }
  }

  // Ghi nhật ký các lệnh bị từ chối
  private async recordRejectedLog(
    farmId: string,
    zoneId: string,
    durationSec: number,
    triggerSource: string,
    reason: string
  ) {
    try {
      const commandId = `rejected-${Date.now()}-${uuidv4().substring(0, 4)}`;
      await prisma.irrigationLog.create({
        data: {
          command_id: commandId,
          zone_id: zoneId,
          duration_sec: durationSec,
          trigger_source: triggerSource,
          status: "REJECTED",
          safety_checks_passed: false,
          rejection_reason: reason,
        },
      });
    } catch (e) {
      console.error("Lỗi khi ghi nhật ký từ chối:", e);
    }
  }
}

export const safetyEngine = new SafetyEngineService();
