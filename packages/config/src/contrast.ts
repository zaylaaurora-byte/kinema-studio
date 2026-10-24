/**
 * WCAG 2.2 relative-luminance contrast calculation.
 *
 * Implemented so contrast can be ASSERTED IN TESTS rather than assumed. The spec sets a
 * WCAG 2.2 AA target, and the easiest way to break that target in this particular
 * design is to use the yellow accent as body text on near-black - which the spec
 * explicitly warns against. A test that measures it is the only reliable guard.
 *
 * Reference: https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
 */

/** Parse a #rrggbb or #rgb hex string into 0-255 channel values. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const value = hex.trim().replace(/^#/, "");

  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`Invalid hex colour: "${hex}"`);
  }

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/**
 * Relative luminance per WCAG 2.2.
 *
 * Note the sRGB gamma correction below; omitting it is the most common way a contrast
 * checker silently reports wrong numbers.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);

  const channel = (c: number): number => {
    const srgb = c / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Round to 2 decimal places, for readable test failure output. */
export function contrastRatioRounded(a: string, b: string): number {
  return Math.round(contrastRatio(a, b) * 100) / 100;
}

export interface ContrastRequirement {
  /** WCAG 2.2 AA minimum for normal body text. */
  readonly body: number;
  /** WCAG 2.2 AA minimum for large text (>=24px, or >=18.66px bold). */
  readonly largeText: number;
  /** WCAG 2.2 AA minimum for UI components and graphical objects. */
  readonly nonText: number;
}

export const WCAG_AA: ContrastRequirement = {
  body: 4.5,
  largeText: 3,
  nonText: 3,
};