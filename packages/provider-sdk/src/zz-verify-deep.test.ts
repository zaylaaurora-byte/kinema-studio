/**
 * VERIFICATION-ONLY (reviewer-added). Targets the four defect classes named by the author:
 * (a) LEN/NLEN on the multi-block path, (b) 5-byte block header bit layout,
 * (c) Adler-32 vs CRC32 confusion, (d) CRC over TYPE+DATA excluding length.
 *
 * The exported surface does not expose crc32/adler32/zlibDeflate/encodePng, so we generate
 * via submitJobAndResolve for sizes the validator allows, and independently re-parse the
 * resulting bytes. For arbitrary dimensions we re-implement the byte-level checks in Python
 * against PNGs produced at allowed sizes plus a direct structural sweep below.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, crc32 as nodeCrc32 } from "node:zlib";

import { describe, it, expect } from "vitest";

import { MockImageAdapter } from "./mock-image.js";

const OUT = "X:/Project Kinema/tmp/verify-deep";

function* pngChunks(data: Buffer) {
  let i = 8;
  while (i < data.length) {
    const len = data.readUInt32BE(i);
    const type = data.subarray(i + 4, i + 8).toString("ascii");
    const payload = data.subarray(i + 8, i + 8 + len);
    const crc = data.readUInt32BE(i + 8 + len);
    yield { len, type, payload, crc, crcInput: data.subarray(i + 4, i + 8 + len) };
    i += 12 + len;
  }
}

/** Parse a store-only (BTYPE=00) deflate stream strictly, checking LEN/NLEN and BFINAL. */
function parseStoredDeflate(zlibStream: Buffer) {
  const cmf = zlibStream[0]!;
  const flg = zlibStream[1]!;
  const cm = cmf & 0x0f;
  const cinfo = cmf >> 4;
  const fdict = (flg >> 5) & 1;
  const fcheck = ((cmf << 8) | flg) % 31;

  let p = 2;
  const out: Buffer[] = [];
  let blocks = 0;
  const blockLog: string[] = [];
  let sawFinal = false;

  // A canonical stored block header is byte-aligned: bit 0 = BFINAL, bits 1-2 = BTYPE,
  // bits 3-7 = padding, then LEN (LE u16) and NLEN (LE u16).
  while (p < zlibStream.length - 4) {
    const b0 = zlibStream[p]!;
    const bfinal = b0 & 1;
    const btype = (b0 >> 1) & 3;
    const padding = b0 >> 3; // must be 0 in a canonical stored block
    if (btype !== 0) throw new Error(`block ${blocks}: BTYPE=${btype}, expected 0 (stored)`);
    const rawHeader = zlibStream.subarray(p, p + 5).toString("hex");
    const len = zlibStream.readUInt16LE(p + 1);
    const nlen = zlibStream.readUInt16LE(p + 3);
    const complementOk = ((len ^ nlen) & 0xffff) === 0xffff;
    blockLog.push(
      `block${blocks} hdr=${rawHeader} bfinal=${bfinal} btype=${btype} padding=${padding} LEN=${len} NLEN=${nlen} complementOk=${complementOk}`,
    );
    if (!complementOk) throw new Error(`block ${blocks}: NLEN is not ~LEN (LEN=${len} NLEN=${nlen})`);
    const slice = zlibStream.subarray(p + 5, p + 5 + len);
    out.push(slice);
    p += 5 + len;
    blocks++;
    if (bfinal === 1) {
      sawFinal = true;
      break;
    }
    if (blocks > 100000) throw new Error("runaway block count");
  }

  const body = Buffer.concat(out);
  const trailing = zlibStream.subarray(p);
  const adler = trailing.readUInt32BE(0);

  // Independent Adler-32 (reference algorithm, not the impl under test).
  let a = 1;
  let b = 0;
  for (const byte of body) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const expectedAdler = (((b << 16) | a) >>> 0);

  return {
    cm, cinfo, fdict, fcheck, blocks, blockLog, sawFinal,
    decompressed: body, adler, expectedAdler,
    trailingBytes: trailing.length,
  };
}

// Independent Adler-32 on arbitrary buffers.
function refAdler32(buf: Buffer) {
  let a = 1, b = 0;
  for (const byte of buf) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return (((b << 16) | a) >>> 0);
}

describe("VERIFY: zlib/deflate container internals", () => {
  it("validates every block header, LEN/NLEN complement and Adler-32", async () => {
    mkdirSync(OUT, { recursive: true });
    const adapter = new MockImageAdapter();
    const report: string[] = [];

    // 512x512 (single-block), 1024x1024 (multi-block: 4195328 raw), 1536x1024 (multi-block)
    for (const size of ["512x512", "1024x1024", "1536x1024", "1024x1536"]) {
      const r = await adapter.submitJobAndResolve({ modelId: "mock-image-v1", prompt: `s-${size}`, size, seed: 99 });
      const png = r.outputs[0]!.data as Buffer;
      const idat = Buffer.concat([...pngChunks(png)].filter((c) => c.type === "IDAT").map((c) => c.payload));
      const d = parseStoredDeflate(idat);

      const w = r.outputs[0]!.width!, h = r.outputs[0]!.height!;
      const expectedRaw = (w * 4 + 1) * h;

      report.push(
        `\n--- ${size} ---\n` +
        `  idat=${idat.length}B raw=${d.decompressed.length}B expectedRaw=${expectedRaw} match=${d.decompressed.length === expectedRaw}\n` +
        `  CM=${d.cm} CINFO=${d.cinfo} FDICT=${d.fdict} FCHECK=${d.fcheck} (must be 0 for zlib)\n` +
        `  blocks=${d.blocks} sawFinal=${d.sawFinal} trailingBytes=${d.trailingBytes} (must be 4)\n` +
        `  adler=${d.adler.toString(16)} expected=${d.expectedAdler.toString(16)} match=${d.adler === d.expectedAdler}\n` +
        `  ${d.blockLog.join("\n  ")}`,
      );

      // Filter bytes: byte 0 of each scanline must be 0 (filter: none), rest is pixel data.
      let filterOk = true;
      for (let y = 0; y < h; y++) if (d.decompressed[y * (w * 4 + 1)] !== 0) filterOk = false;
      report.push(`  allRowFilterBytesZero=${filterOk}`);

      expect(d.decompressed.length).toBe(expectedRaw);
      expect(d.adler).toBe(d.expectedAdler);
      expect(d.sawFinal).toBe(true);
      expect(d.trailingBytes).toBe(4);
      expect(d.fdict).toBe(0);
      expect(d.fcheck).toBe(0);

      // Multi-block must actually occur for the big sizes.
      if (expectedRaw > 65535) expect(d.blocks).toBeGreaterThan(1);
    }

    writeFileSync(join(OUT, "deflate-report.txt"), report.join("\n"));
    console.log("\n===DEFLATE===" + report.join("\n") + "\n===END===");
  }, 300_000);

  it("CRC32 is over TYPE+DATA and matches node:zlib crc32 (independent impl)", async () => {
    mkdirSync(OUT, { recursive: true });
    const adapter = new MockImageAdapter();
    const r = await adapter.submitJobAndResolve({ modelId: "mock-image-v1", prompt: "crc-check", size: "512x512", seed: 4 });
    const png = r.outputs[0]!.data as Buffer;
    const lines: string[] = [];

    for (const c of pngChunks(png)) {
      const mine = c.crc;
      const nodeComputed = nodeCrc32(c.crcInput) >>> 0;
      const overTypeAndLen = nodeCrc32(png.subarray(png.indexOf(c.crcInput) - 4, png.indexOf(c.crcInput) + c.crcInput.length)) >>> 0;
      lines.push(
        `chunk ${c.type} len=${c.len} storedCRC=0x${mine.toString(16).toUpperCase().padStart(8, "0")} ` +
        `node_crc32(type+data)=0x${nodeComputed.toString(16).toUpperCase().padStart(8, "0")} match=${mine === nodeComputed} ` +
        `inclLength_matches=${mine === overTypeAndLen}`,
      );
      expect(mine).toBe(nodeComputed);
      // Proves the length field is EXCLUDED: including it must NOT match.
      expect(mine).not.toBe(overTypeAndLen);
    }
    writeFileSync(join(OUT, "crc-report.txt"), lines.join("\n"));
    console.log("\n===CRC===" + lines.join("\n") + "\n===END===");
  }, 120_000);

  it("known-good reference vectors exist as a cross-check of the reference algorithm", () => {
    // Sanity-check the *reference* helpers used above, so a broken reference cannot
    // silently bless a broken implementation.
    expect(nodeCrc32(Buffer.from("123456789", "ascii")) >>> 0).toBe(0xcbf43926);
    expect(refAdler32(Buffer.from("Wikipedia", "ascii"))).toBe(0x11e60398);
  });
});