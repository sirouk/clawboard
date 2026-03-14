import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { AppConfigProvider } from "@/components/providers";
import { PwaRegister } from "@/components/pwa-register";

export const metadata: Metadata = {
  title: "Clawboard",
  description: "OpenClaw companion for topics, conversations, and logs.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Clawboard",
    statusBarStyle: "black-translucent",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0d12",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <PwaRegister />
        <AppConfigProvider>
          <AppShell>{children}</AppShell>
        </AppConfigProvider>
      </body>
    </html>
  );
}
