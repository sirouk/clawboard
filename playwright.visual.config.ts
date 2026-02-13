import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const dataPath = path.join(process.cwd(), "tests", "fixtures", "portal.json");
const reuseServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1" && !process.env.CI;
const mockApiPort = Number(process.env.PLAYWRIGHT_MOCK_API_PORT ?? "3051");
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? "3050");
const mockApiBase = process.env.PLAYWRIGHT_API_BASE ?? `http://localhost:${mockApiPort}`;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${webPort}`;
const useExternalServer = process.env.PLAYWRIGHT_USE_EXTERNAL_SERVER === "1";
const isCi = (() => {
  const raw = String(process.env.CI ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
})();

if (!process.env.PLAYWRIGHT_API_BASE) process.env.PLAYWRIGHT_API_BASE = mockApiBase;
if (!process.env.PLAYWRIGHT_BASE_URL) process.env.PLAYWRIGHT_BASE_URL = baseURL;

const projects = [
  {
    name: "chromium-desktop",
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1440, height: 900 },
    },
  },
  {
    name: "chromium-mobile",
    use: {
      ...devices["Pixel 7"],
      viewport: { width: 390, height: 844 },
    },
  },
];

if (isCi || process.env.PLAYWRIGHT_VISUAL_WEBKIT === "1") {
  projects.push({
    name: "webkit-mobile",
    use: {
      ...devices["iPhone 13"],
      viewport: { width: 390, height: 844 },
    },
  });
}

export default defineConfig({
  testDir: "./tests/visual",
  // Keep snapshot names stable across macOS/Linux CI hosts.
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.015,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL,
    trace: "on-first-retry",
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
  },
  webServer: useExternalServer
    ? undefined
    : [
        {
          command: `CLAWBOARD_FIXTURE_PATH=${dataPath} MOCK_API_PORT=${mockApiPort} node tests/mock-api.mjs`,
          url: `${mockApiBase}/api/health`,
          reuseExistingServer: reuseServer,
          timeout: 120_000,
        },
        {
          command: `NEXT_PUBLIC_CLAWBOARD_API_BASE=${mockApiBase} npm run build && NEXT_PUBLIC_CLAWBOARD_API_BASE=${mockApiBase} PORT=${webPort} npm run start`,
          url: baseURL,
          reuseExistingServer: reuseServer,
          timeout: 120_000,
        },
      ],
  projects,
});
