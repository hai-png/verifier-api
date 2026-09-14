import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for Cloudflare Pages — the dashboard is a client-side SPA
  // that calls the verifier-api on Render. No server-side rendering needed.
  output: "export",
  images: {
    unoptimized: true, // required for static export
  },
  trailingSlash: true,
};

export default nextConfig;
