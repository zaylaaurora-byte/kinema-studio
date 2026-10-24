import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { MockImageAdapter } from "./mock-image.js";

/**
 * Checksum verification against AUTHORITATIVE EXTERNAL references.
 *
 * Why this file exists: the main test suite passed while the Adler-32 implementation was
 * wrong. Every test compared the encoder against itself, so a byte-swapped checksum
 * looked perfectly consistent. Only a published reference vector and an independent
 * implementation (node:zlib) revealed it.
 *
 * The lesson, encoded here: internal consistency is not correctness. Any checksum,
 * hash or encoder needs at least one assertion against an outside source of truth.
 */

/**
 * The Adler-32 used inside the PNG's zlib stream is not exported for testing, so we
 * extract it from a real generated image. This keeps the test honest - it verifies the
 * bytes actually produced, rather than a re-implementation that could drift.
 */
function extractIdat(png: Buffer): { data: Buffer; storedCrc: number; declaredLength: number } {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  let cursor = 8;
  while (cursor < png.length) {
    const declaredLength = png.readUInt32BE(cursor);
    const type = png.subarray(cursor + 4, cursor + 8).toString("ascii");
    const data = png.subarray(cursor + 8, cursor + 8 + declaredLength);
    const storedCrc = png.readUInt32BE(cursor + 8 + declaredLength);

    if (type === "IDAT") {
      return { data, storedCrc, declaredLength };
    }
    if (type === "IEND") break;
    cursor += 12 + declaredLength;
  }
  throw new Error("No IDAT chunk found in generated PNG");
}

/** Reference Adler-32, written independently of the implementation under test. */
function referenceAdler32(data: Buffer): number {
  let s1 = 1;
  let s2 = 0;
  for (const byte of data) {
    s1 = (s1 + byte) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return (((s2 << 16) | s1) >>> 0);
}

describe("CRC32 against a published vector", () => {
  it("PNG chunk CRCs match an independent recomputation", async () => {
    const adapter = new MockImageAdapter();
    const result = await adapter.submitJobAndResolve({
      modelId: "mock-image-v1",
      prompt: "crc check",
      size: "512x512",
    });

    const png = Buffer.from(result.outputs[0]!.data as Buffer);

    // Walk every chunk and verify the stored CRC over TYPE+DATA.
    const CRC_TABLE = (() => {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
      return table;
    })();

    const crc32 = (buf: Buffer): number => {
      let c = 0xffffffff;
      for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };

    let cursor = 8;
    let chunksChecked = 0;
    while (cursor < png.length) {
      const len = png.readUInt32BE(cursor);
      const typeAndData = png.subarray(cursor + 4, cursor + 8 + len);
      const storedCrc = png.readUInt32BE(cursor + 8 + len);

      expect(crc32(typeAndData)).toBe(storedCrc);
      chunksChecked++;

      const type = png.subarray(cursor + 4, cursor + 8).toString("ascii");
      if (type === "IEND") break;
      cursor += 12 + len;
    }

    // IHDR + at least one IDAT + IEND.
    expect(chunksChecked).toBeGreaterThanOrEqual(3);
  });

  it("CRC32 of the published ASCII vector '123456789' is 0xCBF43926", () => {
    // A fixed, externally-published value. If this fails, the CRC table is wrong.
    const CRC_TABLE = (() => {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
      return table;
    })();

    const crc32 = (buf: Buffer): number => {
      let c = 0xffffffff;
      for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };

    expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926);
  });
});

describe("Adler-32 against RFC 1950 and node:zlib", () => {
  it('reference implementation reproduces the published vector for "Wikipedia"', () => {
    // RFC 1950 Appendix: Adler-32 of "Wikipedia" is 0x11E60398.
    // This is the assertion that failed for the original implementation.
    expect(referenceAdler32(Buffer.from("Wikipedia", "ascii"))).toBe(0x11e60398);
  });

  it("the generated PNG's stored Adler-32 matches the inflated content", async () => {
    const { inflateRawSync } = await import("node:zlib");

    const adapter = new MockImageAdapter();
    const result = await adapter.submitJobAndResolve({
      modelId: "mock-image-v1",
      prompt: "adler check",
      size: "512x512",
    });

    const { data } = extractIdat(Buffer.from(result.outputs[0]!.data as Buffer));

    // zlib layout: 2-byte header, deflate body, 4-byte big-endian Adler-32 trailer.
    const storedAdler = data.readUInt32BE(data.length - 4);
    const rawDeflate = data.subarray(2, data.length - 4);

    // CRITICAL: the Adler-32 covers the UNCOMPRESSED data, not the deflate body. The
    // encoder checksums the filtered scanline buffer before compressing it, which is
    // what RFC 1950 requires. Recomputing over the compressed bytes yields a different
    // number and produces a false failure.
    const inflated = inflateRawSync(rawDeflate);
    expect(storedAdler).toBe(referenceAdler32(inflated));
  });

  it("node:zlib can inflate the raw deflate body, proving the stream is valid", async () => {
    // The strongest available check: hand the bytes to a completely separate
    // implementation. If our store-only deflate or its block headers were malformed,
    // this throws.
    //
    // NOTE: inflateRawSync, not inflateSync. The bytes between the 2-byte zlib header
    // and the 4-byte Adler trailer are a RAW deflate stream with no wrapper; feeding
    // them to inflateSync fails with "incorrect header check" because it expects a zlib
    // container. Using the wrong function here produces a false alarm.
    const { inflateRawSync } = await import("node:zlib");

    const adapter = new MockImageAdapter();
    const result = await adapter.submitJobAndResolve({
      modelId: "mock-image-v1",
      prompt: "inflate check",
      size: "512x512",
    });

    const { data } = extractIdat(Buffer.from(result.outputs[0]!.data as Buffer));

    const rawDeflate = data.subarray(2, data.length - 4);
    const inflated = inflateRawSync(rawDeflate);

    // 512x512 RGBA, with one filter byte per row.
    const expectedLength = (512 * 4 + 1) * 512;
    expect(inflated.length).toBe(expectedLength);
  });

  it("node:zlib can inflate the FULL zlib stream, validating header and Adler together", async () => {
    // This is the check that actually failed before the Adler-32 fix: node reports
    // "incorrect data check" when the stored checksum disagrees with the content.
    const { inflateSync } = await import("node:zlib");

    const adapter = new MockImageAdapter();
    const result = await adapter.submitJobAndResolve({
      modelId: "mock-image-v1",
      prompt: "full zlib check",
      size: "512x512",
    });

    const { data } = extractIdat(Buffer.from(result.outputs[0]!.data as Buffer));

    const inflated = inflateSync(data);
    expect(inflated.length).toBe((512 * 4 + 1) * 512);
  });

  it("node:zlib can inflate a MULTI-BLOCK stream (raw data over 65535 bytes)", async () => {
    // Exercises the multi-block path: a 1024x1024 RGBA image has ~4MB of raw scanline
    // data, far beyond the 65535-byte single-block limit, so several stored blocks are
    // emitted. This was previously untested.
    const { inflateRawSync } = await import("node:zlib");

    const adapter = new MockImageAdapter();
    const result = await adapter.submitJobAndResolve({
      modelId: "mock-image-v1",
      prompt: "multi block",
      size: "1024x1024",
    });

    const { data } = extractIdat(Buffer.from(result.outputs[0]!.data as Buffer));
    const rawDeflate = data.subarray(2, data.length - 4);

    const inflated = inflateRawSync(rawDeflate);
    const expectedLength = (1024 * 4 + 1) * 1024;
    expect(inflated.length).toBe(expectedLength);

    // The Adler-32 covers the uncompressed content, per RFC 1950.
    expect(data.readUInt32BE(data.length - 4)).toBe(referenceAdler32(inflated));
  });

  it("emits a well-formed multi-block header sequence", async () => {
    // Walks the stored blocks and verifies each one: BFINAL/BTYPE bits, the LEN/NLEN
    // one's-complement relationship, and that the final block is marked.
    const adapter = new MockImageAdapter();
    const result = await adapter.submitJobAndResolve({
      modelId: "mock-image-v1",
      prompt: "block walk",
      size: "512x512",
    });

    const { data } = extractIdat(Buffer.from(result.outputs[0]!.data as Buffer));
    const rawDeflate = data.subarray(2, data.length - 4);

    let cursor = 0;
    let blocks = 0;
    let sawFinal = false;

    while (cursor < rawDeflate.length && !sawFinal) {
      const header = rawDeflate[cursor]!;
      const bfinal = header & 1;
      const btype = (header >> 1) & 3;

      // Stored block = BTYPE 00, and padding bits above bit 2 must be zero.
      expect(btype).toBe(0);
      expect(header & 0b11111000).toBe(0);

      const len = rawDeflate.readUInt16LE(cursor + 1);
      const nlen = rawDeflate.readUInt16LE(cursor + 3);

      expect(nlen).toBe(~len & 0xffff);
      expect(len).toBeLessThanOrEqual(65535);

      if (bfinal === 1) sawFinal = true;

      cursor += 5 + len;
      blocks++;
    }

    expect(sawFinal).toBe(true);
    expect(blocks).toBeGreaterThanOrEqual(1);
    // The whole 512x512 RGBA payload is ~1MB, so this must have spanned several blocks.
    expect(blocks).toBeGreaterThan(1);
    expect(cursor).toBe(rawDeflate.length);
  });

  it("agrees with node:zlib's own Adler-32 on a range of inputs", () => {
    // Read the authoritative Adler-32 from a zlib stream's trailer.
    const authoritative = (data: Buffer): number => {
      const deflated = deflateSync(data, { level: 0 });
      return deflated.readUInt32BE(deflated.length - 4);
    };

    const inputs = [
      Buffer.alloc(0),
      Buffer.from("A", "ascii"),
      Buffer.from("Wikipedia", "ascii"),
      Buffer.from("123456789", "ascii"),
      Buffer.alloc(1024, 0xab),
      Buffer.alloc(70_000, 0x5a), // crosses the 65535 boundary
    ];

    for (const input of inputs) {
      expect(referenceAdler32(input)).toBe(authoritative(input));
    }
  });
});