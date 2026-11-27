/* eslint-disable no-bitwise */

type ImageSize = (input: Uint8Array) => { width: number; height: number; type: string };

const imageSize = require("image-size") as ImageSize & { types: string[] };
const NodeBuffer = require("node:buffer").Buffer;
const { spawnSync } = require("node:child_process");
const nodeProcess = require("node:process") as { execPath: string };

function pngFixture(width: number, height: number) {
  const input = NodeBuffer.alloc(24);
  NodeBuffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(input);
  input.writeUInt32BE(width, 16);
  input.writeUInt32BE(height, 20);
  return input;
}

function jpegFixture(width: number, height: number) {
  const input = NodeBuffer.alloc(21);
  input.set([0xff, 0xd8, 0xff, 0xc0]);
  input.writeUInt16BE(17, 4);
  input[6] = 8;
  input.writeUInt16BE(height, 7);
  input.writeUInt16BE(width, 9);
  return input;
}

function webpFixture(width: number, height: number) {
  const input = NodeBuffer.alloc(30);
  input.write("RIFF", 0, "ascii");
  input.write("WEBP", 8, "ascii");
  input.write("VP8X", 12, "ascii");
  input[24] = (width - 1) & 0xff;
  input[25] = ((width - 1) >> 8) & 0xff;
  input[26] = (width - 1) >> 16;
  input[27] = (height - 1) & 0xff;
  input[28] = ((height - 1) >> 8) & 0xff;
  input[29] = (height - 1) >> 16;
  return input;
}

function tiffFixture(width: number, height: number) {
  const input = NodeBuffer.alloc(38);
  input.write("II", 0, "ascii");
  input.writeUInt16LE(42, 2);
  input.writeUInt32LE(8, 4);
  input.writeUInt16LE(2, 8);
  input.writeUInt16LE(256, 10);
  input.writeUInt16LE(3, 12);
  input.writeUInt32LE(1, 14);
  input.writeUInt16LE(width, 18);
  input.writeUInt16LE(257, 22);
  input.writeUInt16LE(3, 24);
  input.writeUInt32LE(1, 26);
  input.writeUInt16LE(height, 30);
  return input;
}

function ktxFixture(width: number, height: number) {
  const input = NodeBuffer.alloc(44);
  NodeBuffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(input);
  input.writeUInt32LE(0x04030201, 12);
  input.writeUInt32LE(width, 36);
  input.writeUInt32LE(height, 40);
  return input;
}

function icnsZeroLengthEntry() {
  const input = NodeBuffer.alloc(16);
  input.write("icns", 0, "ascii");
  input.writeUInt32BE(16, 4);
  input.write("ic07", 8, "ascii");
  input.writeUInt32BE(0, 12);
  return input;
}

function jxlZeroLengthBox() {
  const input = NodeBuffer.alloc(36);
  input.writeUInt32BE(12, 0);
  input.write("JXL ", 4, "ascii");
  input.set([0x0d, 0x0a, 0x87, 0x0a], 8);
  input.writeUInt32BE(16, 12);
  input.write("ftyp", 16, "ascii");
  input.write("jxl ", 20, "ascii");
  input.writeUInt32BE(0, 28);
  input.write("jxlp", 32, "ascii");
  return input;
}

function heifZeroLengthBox() {
  const input = NodeBuffer.alloc(24);
  input.writeUInt32BE(16, 0);
  input.write("ftyp", 4, "ascii");
  input.write("heic", 8, "ascii");
  input.writeUInt32BE(0, 16);
  input.write("free", 20, "ascii");
  return input;
}

function expectBoundedRejection(inputs: Array<{ toString: (encoding: string) => string }>) {
  const script = [
    "const parser = require('image-size');",
    "for (const encoded of JSON.parse(process.argv[1])) {",
    "  try { parser(Buffer.from(encoded, 'base64')); process.exitCode = 2; break; }",
    "  catch (_) {}",
    "}",
  ].join(" ");
  const result = spawnSync(nodeProcess.execPath, [
    "-e",
    script,
    JSON.stringify(inputs.map((input) => input.toString("base64"))),
  ], { encoding: "utf8", timeout: 1000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
}

describe("Metro image-size replacement", () => {
  it("reads bounded dimensions for the PNG assets Metro supports", () => {
    expect(imageSize(pngFixture(48, 32))).toEqual({ width: 48, height: 32, type: "png" });
  });

  it("supports every format Metro registers as an image asset", () => {
    expect(imageSize.types).toEqual(expect.arrayContaining(["png", "gif", "bmp", "jpg", "webp", "psd", "svg", "tiff", "ktx"]));
    const fixtures: Array<[string, Uint8Array, { width: number; height: number; type: string }]> = [
      ["gif", NodeBuffer.from([...NodeBuffer.from("GIF89a", "ascii"), 12, 0, 8, 0]), { width: 12, height: 8, type: "gif" }],
      ["bmp", (() => { const input = NodeBuffer.alloc(26); input.write("BM", 0, "ascii"); input.writeInt32LE(12, 18); input.writeInt32LE(8, 22); return input; })(), { width: 12, height: 8, type: "bmp" }],
      ["jpg", jpegFixture(12, 8), { width: 12, height: 8, type: "jpg" }],
      ["webp", webpFixture(12, 8), { width: 12, height: 8, type: "webp" }],
      ["psd", (() => { const input = NodeBuffer.alloc(26); input.write("8BPS", 0, "ascii"); input.writeUInt16BE(1, 4); input.writeUInt32BE(8, 14); input.writeUInt32BE(12, 18); return input; })(), { width: 12, height: 8, type: "psd" }],
      ["svg", NodeBuffer.from('<svg width="12" height="8"></svg>'), { width: 12, height: 8, type: "svg" }],
      ["tiff", tiffFixture(12, 8), { width: 12, height: 8, type: "tiff" }],
      ["ktx", ktxFixture(12, 8), { width: 12, height: 8, type: "ktx" }],
    ];
    for (const [_type, input, expected] of fixtures) {
      expect(imageSize(input)).toEqual(expected);
    }
  });

  it("rejects real ICNS/JXL/HEIF zero-length loop payloads within a bounded subprocess", () => {
    expectBoundedRejection([icnsZeroLengthEntry(), jxlZeroLengthBox(), heifZeroLengthBox()]);
  });
});
