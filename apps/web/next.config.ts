import type { NextConfig } from "next";

/**
 * The workspace shell is a fully client-rendered editor surface. Nothing here
 * reaches a provider, a database or a render queue yet, so there is deliberately
 * no API route, rewrite or remote image allowance configured - adding one would
 * imply a backend that does not exist.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The design tokens live in a workspace TypeScript package that ships raw
  // `.ts`. Next has to compile it rather than treat it as an opaque node module.
  transpilePackages: ["@kinema/config"],
  typedRoutes: true,
};

export default nextConfig;