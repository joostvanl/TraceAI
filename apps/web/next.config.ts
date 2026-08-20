import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone traces a symlink farm for the Docker image. On Windows that
  // needs Developer Mode / admin; local `next start` does not need it.
  ...(process.platform === "win32" ? {} : { output: "standalone" as const }),
  transpilePackages: ["@traceai/core"],
};

export default nextConfig;