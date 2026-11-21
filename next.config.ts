import type { NextConfig } from "next";

// STATIC=1 builds the GitHub Pages site: plain files in out/, Opus stems, and no
// save API (app/api/loops/route.dev.ts is only picked up for the local app).
// BASE_PATH is the repo's path on Pages, e.g. /op1-loops.
const isStatic = process.env.STATIC === "1";
const basePath = process.env.BASE_PATH || "";

const nextConfig: NextConfig = {
  devIndicators: false,
  output: isStatic ? "export" : undefined,
  basePath: basePath || undefined,
  trailingSlash: isStatic,
  pageExtensions: isStatic ? ["tsx", "ts"] : ["dev.ts", "tsx", "ts"],
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_AUDIO: isStatic ? "opus" : "wav",
  },
};

export default nextConfig;
