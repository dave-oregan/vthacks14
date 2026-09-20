import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack rooted here — the repo root has its own lockfile.
  turbopack: { root: __dirname },
};

export default nextConfig;
