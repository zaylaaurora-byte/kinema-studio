/**
 * Re-export of the shared design tokens.
 *
 * The app NEVER re-declares a colour, size or duration. Anything that needs a
 * value at runtime (canvas geometry, pane clamping, media-query breakpoints)
 * imports it from here, which in turn imports `@kinema/config`. The Tailwind
 * `@theme` block in `globals.css` is the CSS mirror of the same module, and
 * `tokens.test.ts` fails if the two ever disagree.
 */

export {
  a11y,
  breakpoint,
  color,
  elevation,
  layout,
  motion,
  radius,
  space,
  tokens,
  typography,
} from "@kinema/config";

export type { ColorToken, KinemaTokens, SpaceToken } from "@kinema/config";