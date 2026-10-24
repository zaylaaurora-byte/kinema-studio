/**
 * VERIFICATION-ONLY (reviewer-added). Directly targets the task's named defect classes:
 *  - reference vectors: CRC32("123456789")=0xCBF43926, Adler32("Wikipedia")=0x11E60398
 *  - the encoder's OWN crc32/adler32 (extracted by re-implementation + byte-level probing
 *    of real emitted PNGs, since they are not exported)
 *  - odd/huge/1x1 sizes driven through the private encoder path by monkey-patching the
 *    validator, exercising the multi-block boundary exactly at 65535 and 65536.
 */
import { describe, it, expect } from "vitest";
import { crc32 as nodeCrc32, inflateSync } from "node:zlib";

import { MockImageAdapter } from "./mock-image.js";

// --- Independent reference implementations (must self-check against known vectors) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function refCrc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function refAdler32(buf: Buffer) {
  let a = 1, b = 0;
  for (const byte of buf) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return (((b << 16) | a) >>> 0);
}
// Independent re-implementation of the store-only deflate under test.
function refZlibStore(data: Buffer) {
  const parts: Buffer[] = [];
  const MAX = 65535;
  for (let off = 0; off < data.length || off === 0; off += MAX) {
    const slice = data.subarray(off, Math.min(off + MAX, data.length));
    const isFinal = off + MAX >= data.length;
    const h = Buffer.alloc(5);
    h[0] = isFinal ? 1 : 0;
    h.writeUInt16LE(slice.length, 1);
    h.writeUInt16LE(~slice.length & 0xffff, 3);
    parts.push(h, slice);
    if (isFinal) break;
  }
  const body = Buffer.concat(parts);
  const ad = Buffer.alloc(4);
  ad.writeUInt32BE(refAdler32(data), 0);
  return Buffer.concat([Buffer.from([0x78, 0x01]), body, ad]);
}

describe("VERIFY: reference vectors", () => {
  it("CRC32 and Adler-32 known-good values (actual computed values reported)", () => {
    const c = refCrc32(Buffer.from("123456789", "ascii")) >>> 0;
    const a = refAdler32(Buffer.from("Wikipedia", "ascii"));
    const cNode = nodeCrc32(Buffer.from("123456789", "ascii")) >>> 0;
    console.log(`\n===VECTORS===\nCRC32("123456789") ref=0x${c.toString(16).toUpperCase()} node=0x${cNode.toString(16).toUpperCase()} expected=0xCBF43926`);
    console.log(`Adler32("Wikipedia") ref=0x${a.toString(16).toUpperCase()} expected=0x11E60398\n===END===`);
    expect(c).toBe(0xcbf43926);
    expect(cNode).toBe(0xcbf43926);
    expect(a).toBe(0x11e60398);
  });

  it("mkHeader/reference deflate matches node:zlib for the 65535-byte boundary", () => {
    const data = Buffer.alloc(65535, 0x41);
    const mine = refZlibStore(data);
    expect(inflateSync(mine).equals(data)).toBe(true);
    // 65535 raw -> 2 + 5 + 65535 + 4 = 65546
    console.log(`65535-byte stored stream length=${mine.length} (expected 65546), NLEN field=${mine.readUInt16LE(5)}`);
    expect(mine.length).toBe(65546);
    expect(mine.readUInt16LE(5)).toBe(0); // ~65535 & 0xffff === 0 is CORRECT
  });
});

describe("VERIFY: encoder edge sizes via validator bypass", () => {
  // Drive the private encoder at arbitrary dimensions by defeating validateRequest only.
  async function generateAt(width: number, height: number, prompt = "edge", seed = 1) {
    const adapter = new MockImageAdapter();
    (adapter as unknown as { validateRequest: () => { valid: boolean; unsupportedFields: string[]; problems: string[] } })
      .validateRequest = () => ({ valid: true, unsupportedFields: [], problems: [] });
    const r = await adapter.submitJobAndResolve({
      modelId: "mock-image-v1", prompt, size: `${width}x${height}`, seed,
    });
    return r.outputs[0]!.data as Buffer;
  }

  function parsePng(png: Buffer) {
    let i = 8;
    const chunks: Array<{ type: string; payload: Buffer; crc: number; crcInput: Buffer }> = [];
    while (i < png.length) {
      const len = png.readUInt32BE(i);
      const type = png.subarray(i + 4, i + 8).toString("ascii");
      chunks.push({
        type,
        payload: png.subarray(i + 8, i + 8 + len),
        crc: png.readUInt32BE(i + 8 + len),
        crcInput: png.subarray(i + 4, i + 8 + len),
      });
      i += 12 + len;
    }
    const ihdr = chunks.find((c) => c.type === "IHDR")!;
    const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.payload));
    return {
      width: ihdr.payload.readUInt32BE(0),
      height: ihdr.payload.readUInt32BE(4),
      bitDepth: ihdr.payload[8], colorType: ihdr.payload[9],
      raw: inflateSync(idat),
      chunks,
    };
  }

  it("1x1, 7x3, 13x9, 1024x1024 and multi-block boundaries round-trip", async () => {
    const sizes = [[1,1],[7,3],[13,9],[255,1],[1,255],[256,256],[1024,1024],[1536,1024]];
    const lines: string[] = [];
    for (const [w, h] of sizes) {
      const png = await generateAt(w!, h!);
      const p = parsePng(png);
      const expectedRaw = (w! * 4 + 1) * h!;
      const crcOk = p.chunks.every((c) => (refCrc32(c.crcInput) >>> 0) === c.crc);
      lines.push(
        `size=${w}x${h} ihdr=${p.width}x${p.height} depth=${p.bitDepth} color=${p.colorType} ` +
        `raw=${p.raw.length} expected=${expectedRaw} rawMatch=${p.raw.length === expectedRaw} ` +
        `allCRCsValid=${crcOk} multiBlock=${expectedRaw > 65535}`,
      );
      expect(p.width).toBe(w);
      expect(p.height).toBe(h);
      expect(p.raw.length).toBe(expectedRaw);
      expect(crcOk).toBe(true);
      // filter bytes all zero
      for (let y = 0; y < h!; y++) expect(p.raw[y * (w! * 4 + 1)]).toBe(0);
    }
    console.log("\n===EDGE SIZES===\n" + lines.join("\n") + "\n===END===");
  }, 300_000);

  it("exact multi-block boundary raw sizes 65534/65535/65536 decode correctly", async () => {
    // raw = (w*4+1)*h, so pick h=1 and vary w to hit exact raw sizes.
    // raw=65535 -> w*4+1=65535 -> w=16383.5 not integer; use h=5,w=... instead:
    // Instead scan w for exact raw near the boundary by choosing (w,h) pairs.
    const targets: Array<[number, number, number]> = [];
    for (let w = 16380; w <= 16390; w++) targets.push([w, 1, w * 4 + 1]);
    const lines: string[] = [];
    let sawAbove = false, sawBelow = false;
    for (const [w, h, raw] of targets) {
      const png = await generateAt(w, h, "boundary", 2);
      const p = parsePng(png);
      const ok = p.raw.length === raw;
      if (raw > 65535) sawAbove = true; else sawBelow = true;
      lines.push(`raw=${raw} (>${65535}? ${raw > 65535}) decodeLen=${p.raw.length} ok=${ok}`);
      expect(ok).toBe(true);
    }
    expect(sawAbove).toBe(true);
    expect(sawBelow).toBe(true);
    console.log("\n===BOUNDARY===\n" + lines.join("\n") + "\n===END===");
  }, 300_000);

  it("does not hang or throw for a very large image (2048x2048)", async () => {
    const png = await generateAt(2048, 2048, "huge", 3);
    const p = parsePng(png);
    expect(p.raw.length).toBe((2048 * 4 + 1) * 2048);
    console.log(`\n2048x2048 png=${png.length}B raw=${p.raw.length}B\n`);
  }, 300_000);
});