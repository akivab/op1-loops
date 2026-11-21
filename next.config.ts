import type { NextConfig } from "next";

// STATIC=1 builds the GitHub Pages site: plain files in out/ that play the Opus stems.
// BASE_PATH is the repo's path on Pages, e.g. /op1-loops.
const isStatic = process.env.STATIC === "1";
const basePath = process.env.BASE_PATH || "";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: isStatic ? "export" : undefined,
  basePath: basePath || undefined,
  trailingSlash: isStatic,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_AUDIO: isStatic ? "opus" : "wav",
    SITE_URL: process.env.SITE_URL ?? "",
  },
};

export default nextConfig;
