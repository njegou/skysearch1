import type { NextConfig } from "next";

// Export statique : le dossier /out se dépose tel quel sur IONOS.
// Sur GitHub Pages, le workflow fournit PAGES_BASE_PATH (= "/portfolio").
const basePath = process.env.PAGES_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  basePath,
  assetPrefix: basePath || undefined,
};

export default nextConfig;
