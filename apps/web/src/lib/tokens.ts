/**
 * The app's single entry point to the shared design tokens.
 *
 * WHY THIS DOES NOT IMPORT `@kinema/config`'s BARREL
 * --------------------------------------------------
 * `packages/config/src/index.ts` re-exports its siblings with explicit `.js`
 * specifiers:
 *
 *     export * from "./tokens.js";
 *     export * from "./contrast.js";
 *
 * That is the correct NodeNext idiom, but the package ships raw TypeScript (no
 * build step, `exports` points straight at `./src/index.ts`). Neither Turbopack
 * nor Node will rewrite `./tokens.js` to `./tokens.ts`, so importing the barrel
 * fails at build time with:
 *
 *     The export typography was not found in module
 *     [project]/packages/config/src/index.ts (ecmascript).
 *     The module has no exports at all.
 *
 * `packages/config` is a shared package that this app must not modify, so the
 * app imports the two source modules directly instead. Turbopack, Node and `tsc`
 * all resolve a *relative* `../../packages/config/src/tokens` with no extension
 * to the real `.ts` file, and `transpilePackages: ["@kinema/config"]` in
 * `next.config.ts` keeps the workspace package compilable.
 *
 * If the barrel is ever changed to extensionless specifiers, this can collapse
 * back to `export * from "@kinema/config"` with no other edits.
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
} from "../../../../packages/config/src/tokens";

export type {
  ColorToken,
  KinemaTokens,
  SpaceToken,
} from "../../../../packages/config/src/tokens";

export { contrastRatio } from "../../../../packages/config/src/contrast";