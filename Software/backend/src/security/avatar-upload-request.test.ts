import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { receiveAvatar } from "../api/avatar-upload";

function multipartRequest(parts: string[]): Readable & { headers: Record<string, string> } {
  const boundary = "----farmos-avatar-test";
  const body = parts.map((part) => `--${boundary}\r\n${part}\r\n`).join("") + `--${boundary}--\r\n`;
  const request = Readable.from([Buffer.from(body, "latin1")]) as Readable & { headers: Record<string, string> };
  request.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  return request;
}

test("accepts one valid avatar multipart part", async () => {
  const request = multipartRequest([
    'Content-Disposition: form-data; name="avatar"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n\x1a\nimage-data',
  ]);

  const upload = await receiveAvatar(request as never);
  assert.equal(upload.extension, ".png");
  assert.ok(upload.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
});

test("rejects avatar metadata fields", async () => {
  const request = multipartRequest([
    'Content-Disposition: form-data; name="avatar"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n\x1a\nimage-data',
    'Content-Disposition: form-data; name="note"\r\n\r\nuntrusted metadata',
  ]);

  await assert.rejects(receiveAvatar(request as never), { message: "Avatar metadata is not accepted" });
});
