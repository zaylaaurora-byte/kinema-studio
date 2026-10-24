import { describe, it } from "vitest";

import { WCAG_AA, contrastRatioRounded } from "./contrast.js";
import { color } from "./tokens.js";

/**
 * Prints the measured contrast ratio for every real foreground/background pair.
 *
 * Not an assertion suite - `contrast.test.ts` does the enforcing. This exists so the
 * actual numbers are visible when choosing colours, since the palette's near-black
 * surfaces make intuition unreliable (citron on canvas is 16:1, which is the opposite
 * of what "yellow on black" suggests).
 *
 * Run: pnpm --filter @kinema/config exec vitest run contrast-report
 */

const surfaces = {
  canvas: color.canvas,
  canvasRaised: color.canvasRaised,
  panel: color.panel,
  panelElevated: color.panelElevated,
} as const;

const foregrounds = {
  text: color.text,
  textSecondary: color.textSecondary,
  textTertiary: color.textTertiary,
  accent: color.accent,
  mint: color.mint,
  danger: color.danger,
  warning: color.warning,
  focus: color.focus,
} as const;

function verdict(ratio: number): string {
  if (ratio >= WCAG_AA.body) return "AA body";
  if (ratio >= WCAG_AA.largeText) return "AA large only";
  if (ratio >= WCAG_AA.nonText) return "non-text only";
  return "FAIL";
}

describe("contrast report", () => {
  it("prints the token contrast matrix", () => {
    const lines: string[] = ["", "Foreground on background contrast ratios", ""];

    const names = Object.keys(surfaces);
    lines.push(["foreground".padEnd(16), ...names.map((n) => n.padEnd(18))].join(""));
    lines.push("-".repeat(16 + names.length * 18));

    for (const [fgName, fg] of Object.entries(foregrounds)) {
      const cells = [fgName.padEnd(16)];
      for (const surface of Object.values(surfaces)) {
        const ratio = contrastRatioRounded(fg, surface);
        cells.push(`${ratio.toFixed(2)} ${verdict(ratio)}`.padEnd(18));
      }
      lines.push(cells.join(""));
    }

    lines.push("", "Text placed ON a coloured control", "");
    const pairs: [string, string, string][] = [
      ["text (light) on accent", color.text, color.accent],
      ["accentContrast on accent", color.accentContrast, color.accent],
      ["mintContrast on mint", color.mintContrast, color.mint],
    ];
    for (const [label, fg, bg] of pairs) {
      const ratio = contrastRatioRounded(fg, bg);
      lines.push(`  ${label.padEnd(26)} ${ratio.toFixed(2)}  ${verdict(ratio)}`);
    }

    lines.push("", "Thresholds: body >= 4.5, large text >= 3.0, non-text >= 3.0", "");
    console.log(lines.join("\n"));
  });
});