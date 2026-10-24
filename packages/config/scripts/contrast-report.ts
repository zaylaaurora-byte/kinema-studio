/**
 * Report measured WCAG contrast for every real foreground/background pair in the
 * palette. Run this when changing colours; the test suite enforces the minimums, this
 * tells you the actual numbers.
 *
 * Usage: pnpm --filter @kinema/config exec vitest run contrast.test.ts  (for pass/fail)
 *        or run this file directly with node --experimental-strip-types
 */
import { WCAG_AA, contrastRatioRounded } from "../src/contrast.js";
import { color } from "../src/tokens.js";

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

console.log("\nForeground on background contrast ratios\n");
const header = ["foreground", ...Object.keys(surfaces)].map((h) => h.padEnd(16)).join("");
console.log(header);
console.log("-".repeat(header.length));

for (const [fgName, fg] of Object.entries(foregrounds)) {
  const cells = [fgName.padEnd(16)];
  for (const surface of Object.values(surfaces)) {
    const ratio = contrastRatioRounded(fg, surface);
    cells.push(`${ratio.toFixed(2)} ${verdict(ratio)}`.padEnd(16));
  }
  console.log(cells.join(""));
}

console.log("\nText placed ON an accent-filled control\n");
for (const [label, fg] of [
  ["text (light) on accent", color.text],
  ["accentContrast on accent", color.accentContrast],
  ["mintContrast on mint", color.mintContrast],
] as const) {
  const bg = label.includes("mint") ? color.mint : color.accent;
  const ratio = contrastRatioRounded(fg, bg);
  console.log(`  ${label.padEnd(26)} ${ratio.toFixed(2)}  ${verdict(ratio)}`);
}

console.log("\nThresholds: body >= 4.5, large text >= 3.0, non-text >= 3.0\n");