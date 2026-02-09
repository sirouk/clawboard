import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Needed for Next dev server access via Tailscale / LAN hostnames.
  // Next expects *hostnames* (not full origins) that may hit the dev server.
  allowedDevOrigins: Array.from(
    new Set(
      [
        "localhost",
        "127.0.0.1",
        ...(process.env.CLAWBOARD_ALLOWED_DEV_ORIGINS || "")
          .split(",")
          .map((s) => s.trim())
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
