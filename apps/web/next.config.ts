import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typedRoutes: true,
  transpilePackages: ["@waml/db", "@waml/shared"],
};

export default nextConfig;
