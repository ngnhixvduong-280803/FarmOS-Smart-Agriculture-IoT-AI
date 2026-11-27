import fs from "node:fs";
import path from "node:path";
import { Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { AuthRequest, authenticate, requireRole } from "../middleware/auth.middleware";
import {
  cleanupFirmwareMultipart,
  FirmwareUploadError,
  FirmwareUploadService,
  parseFirmwareMultipart,
  type FirmwareReleaseChannel,
  type FirmwareReleaseStatus,
  type ParsedFirmwareUpload,
} from "../../ota/firmware-upload.service";
import { OtaService } from "../../ota/ota.service";

const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false }));
router.use(authenticate, requireRole(["ADMIN"]));

function responseError(error: unknown): { status: number; message: string } {
  if (error instanceof FirmwareUploadError) return { status: error.status, message: error.message };
  if ((error as any)?.code === "P2002") return { status: 409, message: "Firmware release already exists" };
  return { status: 500, message: "Firmware operation failed" };
}

/**
 * POST /api/v1/admin/firmware/releases
 *
 * Multipart file fields:
 *   app (required), bootloader, partitionTable, otaData (optional factory set)
 * Metadata fields are documented by the FirmwareUploadService contract. A
 * release is always created as DRAFT; activation is a separate PATCH action.
 */
router.post("/releases", async (req: AuthRequest, res: Response) => {
  let upload: ParsedFirmwareUpload | undefined;
  try {
    upload = await parseFirmwareMultipart(req);
    const result = await FirmwareUploadService.ingest(upload, req.user!.id);
    return res.status(201).json({
      success: true,
      data: {
        release: result.release,
        ota: result.ota,
        factoryReady: result.factoryReady,
      },
    });
  } catch (error) {
    const failure = responseError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  } finally {
    if (upload) cleanupFirmwareMultipart(upload);
  }
});

router.get("/releases", async (req: AuthRequest, res: Response) => {
  try {
    const all = await FirmwareUploadService.list();
    const releases = req.query.includeLegacy === "true" ? all : all.filter((release) => !release.version.endsWith("-secure"));
    return res.json({ success: true, count: releases.length, data: releases });
  } catch (error) {
    const failure = responseError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.get("/releases/:releaseId", async (req: AuthRequest, res: Response) => {
  try {
    const release = (await FirmwareUploadService.list()).find((item) => item.id === req.params.releaseId);
    if (!release) return res.status(404).json({ success: false, error: "Firmware release not found" });
    return res.json({ success: true, data: release });
  } catch (error) {
    const failure = responseError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.get("/releases/:releaseId/download", async (req: AuthRequest, res: Response) => {
  try {
    const release = (await FirmwareUploadService.list()).find((item) => item.id === req.params.releaseId);
    if (!release) return res.status(404).json({ success: false, error: "Firmware release not found" });

    const imageId = typeof req.query.imageId === "string" ? req.query.imageId.trim() : undefined;
    const targetImage = imageId
      ? release.images.find((img) => img.id === imageId || img.role.toLowerCase() === imageId.toLowerCase())
      : (release.images.find((img) => img.role === "APP") || release.images[0]);

    if (!targetImage) {
      return res.status(404).json({ success: false, error: "Firmware image artifact not found" });
    }

    const fileName = path.basename(targetImage.fileName || `${release.id}.bin`);
    if (!/^[A-Za-z0-9_.-]+$/.test(fileName) || fileName.includes("..")) {
      return res.status(400).json({ success: false, error: "Invalid artifact filename" });
    }

    const storageDir = OtaService.getStorageDir();
    const filePath = path.join(storageDir, fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: "Artifact file does not exist on disk" });
    }

    const stat = fs.statSync(filePath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", stat.size);

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ success: false, error: "Failed to stream artifact file" });
    });
    return stream.pipe(res);
  } catch (error) {
    const failure = responseError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

/** Permanently removes a firmware release, its flash jobs/history and artifacts. */
router.delete("/releases/:releaseId", async (req: AuthRequest, res: Response) => {
  try {
    await FirmwareUploadService.delete(req.params.releaseId);
    return res.status(204).end();
  } catch (error) {
    const failure = responseError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

/** Mutable release controls are deliberately separate from artifact ingest. */
router.patch("/releases/:releaseId", async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const channel = String(body.channel || "").toUpperCase() as FirmwareReleaseChannel;
    const status = body.status === undefined ? undefined : String(body.status).toUpperCase() as FirmwareReleaseStatus;
    const rolloutPercent = body.rolloutPercent === undefined ? undefined : Number(body.rolloutPercent);
    const changelog = body.changelog === undefined ? undefined : String(body.changelog);
    if (changelog !== undefined && changelog.length > 2_000) return res.status(400).json({ success: false, error: "changelog must be at most 2000 characters" });
    const release = await FirmwareUploadService.update(req.params.releaseId, { channel, status, rolloutPercent, changelog });
    return res.json({ success: true, data: release });
  } catch (error) {
    const failure = responseError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

export default router;
