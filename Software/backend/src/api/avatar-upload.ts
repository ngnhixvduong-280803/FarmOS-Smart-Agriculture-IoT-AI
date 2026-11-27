import busboy from "busboy";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request } from "express";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 30_000;

export class AvatarUploadError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function avatarStorageDir(): string {
  if (process.env.AVATAR_STORAGE_DIR) {
    return path.resolve(process.env.AVATAR_STORAGE_DIR);
  }
  if (process.env.NODE_ENV === "test") {
    return path.resolve(os.tmpdir(), "farmos-test-avatars");
  }
  return path.resolve("/var/lib/farmos/avatars");
}

function imageExtension(bytes: Buffer): ".jpg" | ".png" | ".webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return null;
}

/** Accept exactly one bounded image field. The client filename and MIME type
 * are untrusted; the stored extension is derived from the image signature. */
export async function receiveAvatar(req: Request): Promise<{ bytes: Buffer; extension: ".jpg" | ".png" | ".webp" }> {
  const contentType = String(req.headers["content-type"] || "");
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new AvatarUploadError(415, "Avatar must be sent as multipart/form-data");

  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    let settled = false;
    let image: Buffer | null = null;
    let fileSeen = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { req.unpipe(parser); } catch { /* no-op */ }
      try { parser.destroy(); } catch { /* no-op */ }
      reject(error instanceof AvatarUploadError ? error : new AvatarUploadError(400, error instanceof Error ? error.message : "Invalid avatar upload"));
    };
    try {
      // `partsLimit` fires when the number of parsed parts reaches the limit,
      // not only when it exceeds it. With `parts: 1`, a valid one-file upload
      // therefore triggered the error handler below. `files` and `fields`
      // already enforce the intended shape: exactly one file and no metadata.
      parser = busboy({ headers: req.headers, limits: { files: 1, fields: 0, fileSize: MAX_AVATAR_BYTES } });
    } catch (error) {
      fail(error);
      return;
    }
    parser.on("file", (fieldName, file) => {
      if (fieldName !== "avatar" || fileSeen) {
        file.resume();
        fail(new AvatarUploadError(400, "Expected one avatar image"));
        return;
      }
      fileSeen = true;
      const chunks: Buffer[] = [];
      let total = 0;
      file.on("data", (chunk: Buffer) => { total += chunk.length; chunks.push(chunk); });
      file.on("limit", () => fail(new AvatarUploadError(413, "Avatar must be 5 MB or smaller")));
      file.on("error", fail);
      file.on("end", () => { image = Buffer.concat(chunks, total); });
    });
    parser.on("filesLimit", () => fail(new AvatarUploadError(400, "Expected one avatar image")));
    parser.on("fieldsLimit", () => fail(new AvatarUploadError(400, "Avatar metadata is not accepted")));
    parser.on("error", fail);
    parser.on("finish", () => {
      if (settled) return;
      if (!image?.length) return fail(new AvatarUploadError(400, "Avatar image is required"));
      const extension = imageExtension(image);
      if (!extension) return fail(new AvatarUploadError(415, "Avatar must be a JPEG, PNG, or WebP image"));
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ bytes: image, extension });
    });
    req.once("aborted", () => fail(new AvatarUploadError(400, "Avatar upload was interrupted")));
    req.once("error", fail);
    timeout = setTimeout(() => fail(new AvatarUploadError(408, "Avatar upload timed out")), UPLOAD_TIMEOUT_MS);
    timeout.unref?.();
    req.pipe(parser);
  });
}

export function userAvatarPrefix(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

export function cleanUserAvatars(userId: string, keepFilename?: string): void {
  const directory = avatarStorageDir();
  if (!fs.existsSync(directory)) return;
  const prefix = `${userAvatarPrefix(userId)}-`;
  try {
    const files = fs.readdirSync(directory);
    for (const file of files) {
      if (file.startsWith(prefix) && file !== keepFilename) {
        try { fs.rmSync(path.join(directory, file), { force: true }); } catch { /* a stale file is harmless */ }
      }
    }
  } catch { /* directory read failure is non-fatal */ }
}

export function saveAvatar(userId: string, bytes: Buffer, extension: ".jpg" | ".png" | ".webp"): string {
  const directory = avatarStorageDir();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = `${userAvatarPrefix(userId)}-${crypto.randomUUID()}${extension}`;
  fs.writeFileSync(path.join(directory, filename), bytes, { flag: "wx", mode: 0o600 });
  // Giữ đúng 1 ảnh duy nhất cho mỗi user: dọn sạch mọi file cũ trước đó của user này
  cleanUserAvatars(userId, filename);
  return filename;
}

export function removeManagedAvatar(avatarUrl: string | null | undefined): void {
  if (!avatarUrl) return;
  const filename = avatarUrl.split("/").pop();
  if (!filename || !/^[a-f0-9]{24}-[0-9a-f-]{36}\.(jpg|png|webp)$/.test(filename)) return;
  try { fs.rmSync(path.join(avatarStorageDir(), filename), { force: true }); } catch { /* a stale file is harmless */ }
}
