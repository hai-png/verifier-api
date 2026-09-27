import type { NextConfig } from "next";

// NEXT_PUBLIC_* values are inlined into the client bundle at build time, so this
// is the last moment anyone can notice that the dashboard was built without
// knowing which API to talk to. lib/config.ts falls back to same-origin, which on
// a static export means every call 404s — visible, but only after deploy. Say it
// here instead.
//
// This used to default, in six separate files, to a specific third-party Render
// host. On a branch called `selfhosted`, a fork that forgot the variable would
// have posted its users' credentials and API keys to that host.
const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "").trim();
if (!apiBase) {
  console.warn(
    "\n[next.config] ⚠️  NEXT_PUBLIC_API_URL is not set.\n" +
      "           The dashboard will be built to call its own origin, and this is a static\n" +
      "           export, so every API request will fail. Build with:\n" +
      "             NEXT_PUBLIC_API_URL=https://your-api.example.com npm run build\n" +
      "           See web/.env.example.\n",
  );
}

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
