import { Router, Request, Response, NextFunction } from "express";
import fs from "node:fs";
import { OtaService } from "../../ota/ota.service";
import { prisma } from "../../database/prisma";
import { AuthRequest, authenticate } from "../middleware/auth.middleware";
import { GatewayRequest, requireGatewayAuth } from "../middleware/gateway-auth.middleware";
import { createOtaDownloadTicket, verifyOtaDownloadTicket } from "../../security/device-secrets";

const router = Router();
type OtaRequest = AuthRequest & GatewayRequest;
const OTA_STATUSES = ["DOWNLOADING", "FLASHING", "FLASHED", "BOOT_CONFIRMED", "FAILED"] as const;

function authenticateOtaClient(req: OtaRequest, res: Response, next: NextFunction) {
  if (req.header("x-farmos-device-id") || req.header("x-farmos-device-token") ||
      req.header("x-farmos-gateway-id") || req.header("x-farmos-gateway-token")) {
    return requireGatewayAuth(req, res, next);
  }
  return authenticate(req, res, next);
}

async function userMayAccessDevice(req: OtaRequest, deviceId: string): Promise<boolean> {
  if (req.gatewayId) return req.gatewayId === deviceId;
  const user = req.user!;
  const node = await prisma.node.findUnique({
    where: { id: deviceId },
    select: { owner_id: true, farm_id: true, is_activated: true },
  });
  if (!node) return false;
  if (!node.is_activated) return false;
  const identity = await prisma.deviceIdentity.findUnique({ where: { device_id: deviceId }, select: { state: true } });
  if (identity && ["REVOKED", "QUARANTINED"].includes(identity.state)) return false;
  if (user.role === "ADMIN" || node.owner_id === user.id) return true;
  if (!node.farm_id) return false;
  return Boolean(await prisma.userFarm.findUnique({
    where: { user_id_farm_id: { user_id: user.id, farm_id: node.farm_id } },
    select: { user_id: true },
  }));
}

async function deviceHasType(deviceId: string, deviceType: string): Promise<boolean> {
  const node = await prisma.node.findUnique({ where: { id: deviceId }, select: { type: true } });
  return node?.type === deviceType;
}

async function otaIdentity(deviceId: string) {
  return prisma.deviceIdentity.findUnique({ where: { device_id: deviceId }, select: {
    firmware_target: true, hardware_revision: true, partition_scheme: true,
  } });
}

const OTA_TRANSITIONS: Record<string, string[]> = {
  AVAILABLE: ["DOWNLOADING", "FAILED"],
  DOWNLOADING: ["FLASHING", "FAILED"],
  // BOOT_CONFIRMED is authoritative evidence from the rebooted device. Allow
  // it to reconcile a job when the non-authoritative FLASHED report was lost.
  FLASHING: ["FLASHED", "BOOT_CONFIRMED", "FAILED"],
  FLASHED: ["BOOT_CONFIRMED", "FAILED"],
  // A client may have recorded FAILED because its status-report request died
  // even though the device completed the flash. A later version read must be
  // able to repair that server-side state.
  FAILED: ["DOWNLOADING", "BOOT_CONFIRMED"],
  BOOT_CONFIRMED: [],
};

export function canTransitionOtaStatus(current: string, next: string): boolean {
  return current === next || (OTA_TRANSITIONS[current] || []).includes(next);
}

class OtaStatusConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtaStatusConflictError";
  }
}

/**
 * GET /api/v1/ota/check
 * Query: deviceType ("GATEWAY" | "SENSOR_NODE"), currentVersion (string, e.g. "0.2.0")
 */
router.get("/check", authenticateOtaClient, async (req: OtaRequest, res: Response) => {
  try {
    const deviceType = req.query.deviceType as "GATEWAY" | "SENSOR_NODE";
    const currentVersion = String(req.query.currentVersion || "").trim();
    const deviceId = req.gatewayId || String(req.query.deviceId || "").trim();

    if (!deviceType || !["GATEWAY", "SENSOR_NODE"].includes(deviceType)) {
      return res.status(400).json({
        success: false,
        error: "deviceType phải là GATEWAY hoặc SENSOR_NODE",
      });
    }

    if (!currentVersion || !deviceId) {
      return res.status(400).json({
        success: false,
        error: "Thiếu currentVersion hoặc deviceId",
      });
    }
    if (!(await userMayAccessDevice(req, deviceId))) {
      return res.status(404).json({ success: false, error: "Không tìm thấy thiết bị" });
    }
    if (!(await deviceHasType(deviceId, deviceType))) {
      return res.status(400).json({ success: false, error: "Loại firmware không khớp thiết bị" });
    }

    const identity = await otaIdentity(deviceId);
    if (!identity) return res.status(409).json({ success: false, error: "Thiết bị thiếu factory identity cho OTA" });

    const checkResult = await OtaService.checkUpdate(deviceType, currentVersion, deviceId, {
      firmwareTarget: identity.firmware_target,
      hardwareRevision: identity.hardware_revision,
      partitionScheme: identity.partition_scheme,
    });
    let jobId: string | undefined;
    let downloadUrl: string | undefined;
    if (checkResult.updateAvailable && checkResult.latestRelease) {
      const release = checkResult.latestRelease;
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      const reporterType = req.gatewayId ? "DEVICE" : "USER";
      const reporterId = req.gatewayId || req.user!.id;
      const job = await prisma.otaUpdateJob.upsert({
        where: { device_id_release_id: { device_id: deviceId, release_id: release.id } },
        // A repeated check may refresh the lease, but must never rewind a job
        // that another client/device is already flashing.
        update: { expires_at: expiresAt },
        create: {
          device_id: deviceId, release_id: release.id, firmware_target: release.firmwareTarget,
          target_version: release.version, target_sha256: release.sha256, status: "AVAILABLE",
          initiated_by_type: reporterType, initiated_by_id: reporterId, expires_at: expiresAt,
        },
      });
      jobId = job.id;
      const ticket = createOtaDownloadTicket({
        deviceId, jobId: job.id, releaseId: release.id, sha256: release.sha256,
        expiresAt: Date.now() + 15 * 60_000,
      });
      downloadUrl = `/api/v1/ota/download/${deviceType}/${release.version}?ticket=${encodeURIComponent(ticket)}`;
    }

    return res.json({
      success: true,
      data: {
        ...checkResult,
        ...(jobId ? { jobId } : {}),
        ...(downloadUrl ? { downloadUrl } : {}),
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: "Lỗi kiểm tra phiên bản OTA",
    });
  }
});

/**
 * GET /api/v1/ota/releases
 * Query: deviceType (optional "GATEWAY" | "SENSOR_NODE")
 */
router.get("/releases", authenticateOtaClient, async (req: OtaRequest, res: Response) => {
  try {
    const deviceType = req.query.deviceType as "GATEWAY" | "SENSOR_NODE" | undefined;
    if (deviceType && !["GATEWAY", "SENSOR_NODE"].includes(deviceType)) {
      return res.status(400).json({
        success: false,
        error: "deviceType không hợp lệ",
      });
    }
    if (req.gatewayId && (!deviceType || !(await deviceHasType(req.gatewayId, deviceType)))) {
      return res.status(403).json({ success: false, error: "Thiết bị chỉ được xem đúng firmware target của mình" });
    }

    // The OTA client surface is not the firmware catalog. Never expose draft,
    // paused, or revoked release metadata to ordinary authenticated users;
    // administrators have the separate catalog endpoint for lifecycle work.
    const releases = (await OtaService.listReleases(deviceType)).filter((release) => release.status === "ACTIVE");
    return res.json({
      success: true,
      data: releases,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: "Lỗi lấy danh sách bản phát hành",
    });
  }
});

router.get("/events", authenticateOtaClient, async (req: OtaRequest, res: Response) => {
  try {
    const deviceId = req.gatewayId || String(req.query.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ success: false, error: "Thiếu deviceId" });
    if (!(await userMayAccessDevice(req, deviceId))) {
      return res.status(404).json({ success: false, error: "Không tìm thấy thiết bị" });
    }
    const requestedLimit = Number(req.query.limit || 50);
    const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    const events = await prisma.otaEvent.findMany({
      where: { device_id: deviceId },
      orderBy: { created_at: "desc" },
      take: limit,
    });
    return res.json({ success: true, data: events });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: "Lỗi đọc lịch sử OTA" });
  }
});

/**
 * GET /api/v1/ota/download/:deviceType/:version
 * Streams binary firmware file to client/gateway/mobile
 */
router.get("/download/:deviceType/:version", authenticateOtaClient, async (req: OtaRequest, res: Response) => {
  try {
    const { deviceType, version } = req.params;
    if (!deviceType || !["GATEWAY", "SENSOR_NODE"].includes(deviceType.toUpperCase())) {
      return res.status(400).json({
        success: false,
        error: "deviceType phải là GATEWAY hoặc SENSOR_NODE",
      });
    }
    const ticket = verifyOtaDownloadTicket(String(req.query.ticket || ""));
    if (!ticket) return res.status(401).json({ success: false, error: "OTA download ticket không hợp lệ hoặc đã hết hạn" });
    if (!(await userMayAccessDevice(req, ticket.deviceId))) {
      return res.status(404).json({ success: false, error: "Không tìm thấy thiết bị" });
    }
    if (!(await deviceHasType(ticket.deviceId, deviceType.toUpperCase()))) {
      return res.status(403).json({ success: false, error: "Firmware không khớp thiết bị" });
    }

    const release = await OtaService.getReleaseById(ticket.releaseId);

    if (!release || release.deviceType !== deviceType.toUpperCase() || release.version !== version.replace(/^v/i, "")) {
      return res.status(404).json({
        success: false,
        error: `Không tìm thấy firmware cho ${deviceType} v${version}`,
      });
    }
    const job = await prisma.otaUpdateJob.findUnique({ where: { id: ticket.jobId } });
    if (!job || job.device_id !== ticket.deviceId || job.release_id !== release.id ||
        job.firmware_target !== release.firmwareTarget || job.target_sha256 !== release.sha256 || ticket.releaseId !== release.id ||
        ticket.sha256 !== release.sha256 || job.expires_at <= new Date() ||
        !["AVAILABLE", "DOWNLOADING", "FAILED"].includes(job.status) || release.status !== "ACTIVE") {
      return res.status(409).json({ success: false, error: "OTA job hoặc release không còn hợp lệ" });
    }

    const binaryPath = OtaService.verifyStoredArtifact(release.fileName, release.sha256, release.sizeBytes);
    if (!binaryPath) {
      return res.status(404).json({
        success: false,
        error: "File firmware binary không tồn tại hoặc không khớp hash trên hệ thống lưu trữ",
      });
    }

    const stat = fs.statSync(binaryPath);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${release.fileName}"`);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("X-OTA-SHA256", release.sha256);
    res.setHeader("X-OTA-Version", release.version);
    res.setHeader("X-OTA-Device-Type", release.deviceType);
    res.setHeader("Cache-Control", "private, no-store");

    const stream = fs.createReadStream(binaryPath);
    stream.pipe(res);
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: "Lỗi tải xuống firmware",
    });
  }
});

/**
 * POST /api/v1/ota/status
 * Report OTA flashing progress or final status from Gateway or Mobile App
 * Body: { deviceId, deviceType, targetVersion, status: "DOWNLOADING" | "FLASHING" | "FLASHED" | "BOOT_CONFIRMED" | "FAILED", progress?: number, error?: string }
 */
router.post("/status", authenticateOtaClient, async (req: OtaRequest, res: Response) => {
  try {
    const { deviceId, deviceType, targetVersion, status, progress, error } = req.body;
    const requestedJobId = req.body.jobId ? String(req.body.jobId) : "";

    if (!deviceId || !deviceType || !targetVersion || !status) {
      return res.status(400).json({
        success: false,
        error: "Thiếu deviceId, deviceType, targetVersion hoặc status",
      });
    }
    if (!["GATEWAY", "SENSOR_NODE"].includes(deviceType) ||
        !OTA_STATUSES.includes(status) ||
        (progress !== undefined && (!Number.isInteger(progress) || progress < 0 || progress > 100))) {
      return res.status(400).json({ success: false, error: "Trạng thái OTA không hợp lệ" });
    }
    if (req.gatewayId && req.gatewayId !== deviceId) {
      return res.status(403).json({ success: false, error: "Thiết bị không được báo trạng thái cho thiết bị khác" });
    }
    if (!(await userMayAccessDevice(req, deviceId))) {
      return res.status(404).json({ success: false, error: "Không tìm thấy thiết bị" });
    }
    if (!(await deviceHasType(deviceId, deviceType))) {
      return res.status(400).json({ success: false, error: "Loại firmware không khớp thiết bị" });
    }
    // Only the authenticated device (Gateway or standalone Wi-Fi Node) can
    // prove it rebooted into the target image. A mobile bearer may report
    // download/flash progress, but must never forge authoritative confirmation.
    if (status === "BOOT_CONFIRMED" && !req.gatewayId) {
      return res.status(403).json({ success: false, error: "BOOT_CONFIRMED chỉ được báo bởi thiết bị sau reboot" });
    }

    let job = requestedJobId ? await prisma.otaUpdateJob.findUnique({ where: { id: requestedJobId } }) : null;
    // After reboot a device may have lost its in-RAM job id. Only the device
    // itself may recover the matching in-flight job for final confirmation.
    // A failed/retried FLASHED report can leave the job at FLASHING, so both
    // pre-reboot states must be recoverable here.
    if (!job && req.gatewayId && status === "BOOT_CONFIRMED") {
      job = await prisma.otaUpdateJob.findFirst({ where: {
        device_id: deviceId, target_version: String(targetVersion).replace(/^v/i, ""),
        status: { in: ["FLASHED", "FLASHING"] }, expires_at: { gt: new Date() },
      }, orderBy: { updated_at: "desc" } });
    }
    const release = job ? await OtaService.getReleaseById(job.release_id) : null;
    if (!release || release.status === "REVOKED") {
      return res.status(409).json({ success: false, error: "Bản firmware không còn hợp lệ hoặc đã bị thu hồi" });
    }
    if (!job || job.device_id !== deviceId || job.release_id !== release.id ||
        String(targetVersion).replace(/^v/i, "") !== release.version ||
        job.firmware_target !== release.firmwareTarget ||
        job.target_version !== release.version || job.target_sha256 !== release.sha256 ||
        job.expires_at <= new Date()) {
      return res.status(409).json({ success: false, error: "OTA job không hợp lệ hoặc đã hết hạn" });
    }
    if (!canTransitionOtaStatus(job.status, status)) {
      return res.status(409).json({ success: false, error: `Chuyển trạng thái OTA ${job.status} -> ${status} không hợp lệ` });
    }

    console.log(
      `[OTA] Trạng thái cập nhật thiết bị ${deviceId} (${deviceType}) -> v${targetVersion}: ${status} ${progress !== undefined ? `(${progress}%)` : ""}`
    );

    const reporterType = req.gatewayId ? "DEVICE" : "USER";
    const reporterId = req.gatewayId || req.user!.id;
    await prisma.$transaction(async (tx) => {
      // The optimistic status check above is only a fast rejection. Lock and
      // re-read the job before writing the event so two status reports cannot
      // both transition from the same stale state or turn a normal retry into
      // a 500 after the first request commits.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ota_update_jobs" WHERE "id" = ${job.id} FOR UPDATE
      `;
      const currentJob = await tx.otaUpdateJob.findUnique({ where: { id: job.id } });
      if (!currentJob || currentJob.device_id !== deviceId || currentJob.release_id !== release.id ||
          currentJob.firmware_target !== release.firmwareTarget || currentJob.target_version !== release.version ||
          currentJob.target_sha256 !== release.sha256 || currentJob.expires_at <= new Date()) {
        throw new OtaStatusConflictError("OTA job không hợp lệ hoặc đã hết hạn");
      }
      if (!canTransitionOtaStatus(currentJob.status, status)) {
        throw new OtaStatusConflictError(`Chuyển trạng thái OTA ${currentJob.status} -> ${status} không hợp lệ`);
      }
      await tx.otaEvent.create({
        data: {
          job_id: currentJob.id,
          device_id: deviceId,
          device_type: deviceType,
          target_version: release.version,
          status,
          progress: progress ?? (["FLASHED", "BOOT_CONFIRMED"].includes(status) ? 100 : null),
          error: error ? String(error).slice(0, 500) : null,
          reporter_type: reporterType,
          reporter_id: reporterId,
        },
      });
      if (currentJob.status !== status) {
        await tx.otaUpdateJob.update({
          where: { id: currentJob.id },
          data: { status },
        });
      }
      // Only firmware observed after a successful reboot becomes authoritative.
      if (status === "BOOT_CONFIRMED") {
        await tx.node.update({
          where: { id: deviceId },
          data: { firmware_version: release.version, updated_at: new Date() },
        });
      }
    });

    return res.json({
      success: true,
      message: "Đã ghi nhận trạng thái cập nhật OTA",
      data: {
        deviceId,
        targetVersion,
        status,
        progress: progress ?? (["FLASHED", "BOOT_CONFIRMED"].includes(status) ? 100 : 0),
        error: error || null,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    if (err instanceof OtaStatusConflictError) {
      return res.status(409).json({ success: false, error: err.message });
    }
    return res.status(500).json({
      success: false,
      error: "Lỗi cập nhật trạng thái OTA",
    });
  }
});

export default router;
