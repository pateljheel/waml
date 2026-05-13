import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    typedRoutes: true,
  },
  transpilePackages: ["@waml/db", "@waml/shared"],
};

export default nextConfig;
