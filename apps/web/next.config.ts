import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

/**
 * Turbopack restricts module resolution to the project root by default, which
 * would block `src/lib/tokens.ts` from reaching the sibling workspace package's
 * source. The monorepo root is the correct boundary: `@kinema/config` is a
 * workspace dependency of this app, not an outside-the-repo import.
 *
 * It must be ABSOLUTE. A relative value logs
 * "turbopack.root should be absolute, using: <resolved>" and then resolves
 * against the process CWD, which is only correct when the build is launched from
 * `apps/web`. `import.meta.url` is stable regardless of CWD.
 */
const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: monorepoRoot,
  },
  // The design tokens live in a workspace TypeScript package that ships raw
  // `.ts`, so Next must compile it rather than treat it as an opaque node module.
  transpilePackages: ["@kinema/config"],
  typedRoutes: true,
};

export default nextConfig;