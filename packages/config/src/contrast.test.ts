import { describe, expect, it } from "vitest";

import { WCAG_AA, contrastRatioRounded, parseHex, relativeLuminance } from "./contrast.js";
import { color } from "./tokens.js";

/**
 * These tests enforce the specification's accessibility target (WCAG 2.2 AA) against
 * the real token values. If someone later changes a colour and breaks contrast, this
 * fails loudly instead of the regression being discovered by a user who cannot read
 * the interface.
 */

describe("parseHex", () => {
  it("parses six-digit hex", () => {
    expect(parseHex("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#000000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("parses three-digit shorthand", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("tolerates a missing leading hash", () => {
    expect(parseHex("E6F55A")).toEqual({ r: 230, g: 245, b: 90 });
  });

  it("throws on malformed input rather than returning nonsense", () => {
    expect(() => parseHex("#GGGGGG")).toThrow(/Invalid hex/);
    expect(() => parseHex("#12345")).toThrow(/Invalid hex/);
  });
});

describe("relativeLuminance", () => {
  it("returns 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBe(1);
  });

  it("applies sRGB gamma correction (not a naive average)", () => {
    // Mid-grey 0x808080 is ~0.216 luminance, NOT ~0.5. A naive average would give
    // 0.502 and would make every contrast calculation wrong.
    const mid = relativeLuminance("#808080");
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.23);
  });
});

describe("contrastRatio", () => {
  it("computes the known extremes", () => {
    expect(contrastRatioRounded("#000000", "#FFFFFF")).toBe(21);
    expect(contrastRatioRounded("#FFFFFF", "#FFFFFF")).toBe(1);
  });

  it("is symmetric", () => {
    expect(contrastRatioRounded("#0B0D0E", "#F4F5F2")).toBe(
      contrastRatioRounded("#F4F5F2", "#0B0D0E"),
    );
  });
});

describe("design tokens meet WCAG 2.2 AA", () => {
  const surfaces = {
    canvas: color.canvas,
    canvasRaised: color.canvasRaised,
    panel: color.panel,
    panelElevated: color.panelElevated,
  } as const;

  describe("primary text passes body-text contrast on every surface", () => {
    for (const [name, surface] of Object.entries(surfaces)) {
      it(`text on ${name}`, () => {
        const ratio = contrastRatioRounded(color.text, surface);
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA.body);
      });
    }
  });

  describe("secondary text passes body-text contrast", () => {
    for (const [name, surface] of Object.entries(surfaces)) {
      it(`textSecondary on ${name}`, () => {
        const ratio = contrastRatioRounded(color.textSecondary, surface);
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA.body);
      });
    }
  });

  describe("tertiary text passes body-text contrast", () => {
    // This guard exists because it was needed. The first-pass tertiary value (#6F7876)
    // measured 3.44:1 on the elevated panel and would have shipped a WCAG AA failure
    // for timestamps and other small metadata.
    for (const [name, surface] of Object.entries(surfaces)) {
      it(`textTertiary on ${name}`, () => {
        const ratio = contrastRatioRounded(color.textTertiary, surface);
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA.body);
      });
    }
  });

  it("accent text on an accent-filled control is readable", () => {
    // The citron accent is light, so the text placed on it must be dark. Using the
    // light `text` token here would be nearly invisible.
    const ratio = contrastRatioRounded(color.accentContrast, color.accent);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA.body);
  });

  it("mint accent pairs legibly with its contrast colour", () => {
    const ratio = contrastRatioRounded(color.mintContrast, color.mint);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA.body);
  });

  it("status colours are legible on panel surfaces", () => {
    for (const status of [color.danger, color.warning, color.success, color.info]) {
      const ratio = contrastRatioRounded(status, color.panel);
      // Status text is often small, so require the stricter body threshold.
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA.body);
    }
  });

  it("the focus ring is distinguishable from every surface it appears on", () => {
    // WCAG 2.2 non-text contrast. A focus ring that blends into the background is a
    // keyboard-accessibility failure, and this design's near-black palette makes that
    // an easy mistake.
    for (const surface of Object.values(surfaces)) {
      const ratio = contrastRatioRounded(color.focus, surface);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA.nonText);
    }
  });

  it("borders are perceptible against their adjacent surfaces", () => {
    const ratio = contrastRatioRounded(color.border, color.panel);
    expect(ratio).toBeGreaterThan(1);
  });

  it("DOCUMENTS why accent yellow is reserved for accents, not body text", () => {
    // The spec states: "Preserve contrast: yellow as an accent, not dense body text on
    // black."
    //
    // Measured, that guidance is NOT about failing WCAG. Citron on the near-black
    // canvas scores well above the 4.5 body minimum, because citron is a high-luminance
    // colour - the opposite of what "yellow on black" intuition suggests. The real
    // reasons to keep it as an accent are:
    //
    //   1. A large area of a highly luminous colour on a near-black field causes glare
    //      and is tiring to read over long sessions.
    //   2. If body text is the accent, the accent stops signifying anything. This app
    //      uses it for primary actions and selection, which only works while it is
    //      scarce.
    //
    // This test records the measurement so the guidance is not re-argued with a wrong
    // premise, and pins the *intent*: the accent must stay far above body contrast so
    // it reads as deliberate emphasis, never as muted text.
    const ratio = contrastRatioRounded(color.accent, color.canvas);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA.body);
    // It should be emphatic, not merely legible.
    expect(ratio).toBeGreaterThan(10);
  });

  it("shows why the accent cannot carry light text on top of it", () => {
    // The practical hazard with a luminous accent is text placed ON it, not on the
    // canvas. This is the case that genuinely fails, and the reason the palette needs a
    // dedicated `accentContrast` token at all.
    const lightOnAccent = contrastRatioRounded(color.text, color.accent);
    expect(lightOnAccent).toBeLessThan(WCAG_AA.body);

    const darkOnAccent = contrastRatioRounded(color.accentContrast, color.accent);
    expect(darkOnAccent).toBeGreaterThanOrEqual(WCAG_AA.body);
  });
});