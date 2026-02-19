import type { NextConfig } from "next";

const normalizeAllowedDevOrigin = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes("*")) return trimmed;

  // Next expects hostnames (not full origins). Accept either.
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return "";
    }
  }

  // Accept host:port but keep only the hostname.
  return trimmed.split("/")[0].split(":")[0];
};

const nextConfig: NextConfig = {
  // Turbopack can mis-infer the repo root when multiple lockfiles exist in parent
  // directories, which then breaks Tailwind/config discovery.
  turbopack: {
    root: __dirname
  },
  // Keep more routes hot in dev so switching between Board/Graph/Logs/Settings
  // does not repeatedly evict and recompile page bundles.
  onDemandEntries: {
    maxInactiveAge: 15 * 60 * 1000,
    pagesBufferLength: 32,
  },
  // Needed for Next dev server access via Tailscale / LAN hostnames.
  // Next expects *hostnames* (not full origins) that may hit the dev server.
  allowedDevOrigins: Array.from(
    new Set(
      [
        "localhost",
        "127.0.0.1",
        // Common LAN mDNS hostnames, e.g. `my-mac-mini.local`.
        "*.local",
        // Tailscale MagicDNS, e.g. `host.tailXXXX.ts.net` (variable subdomain depth).
        "**.ts.net",
        // Tailscale CGNAT range commonly used for tailnet IPs (e.g. `100.91.119.30`).
        "100.*.*.*",
        ...(process.env.CLAWBOARD_ALLOWED_DEV_ORIGINS || "")
          .split(",")
          .map(normalizeAllowedDevOrigin)
          .filter(Boolean),
      ].filter(Boolean),
    ),
  ),
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
