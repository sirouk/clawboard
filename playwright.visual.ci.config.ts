import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const dataPath = path.join(process.cwd(), "tests", "fixtures", "portal.json");
const reuseServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1" && !process.env.CI;
const useExternalServer = process.env.PLAYWRIGHT_USE_EXTERNAL_SERVER === "1";
const loopbackHost = process.env.PLAYWRIGHT_LOOPBACK_HOST ?? "127.0.0.1";
const mockApiPort = Number(process.env.PLAYWRIGHT_MOCK_API_PORT ?? "3151");
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? "3150");
const mockApiBase = process.env.PLAYWRIGHT_API_BASE ?? `http://${loopbackHost}:${mockApiPort}`;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://${loopbackHost}:${webPort}`;

if (!process.env.PLAYWRIGHT_API_BASE) process.env.PLAYWRIGHT_API_BASE = mockApiBase;
if (!process.env.PLAYWRIGHT_BASE_URL) process.env.PLAYWRIGHT_BASE_URL = baseURL;

export default defineConfig({
  testDir: "./tests/visual-ci",
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
  timeout: 60_000,
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
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
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
          command: `CLAWBOARD_FIXTURE_PATH=${dataPath} MOCK_API_HOST=${loopbackHost} MOCK_API_PORT=${mockApiPort} node tests/mock-api.mjs`,
          url: `${mockApiBase}/api/health`,
          reuseExistingServer: reuseServer,
          timeout: 120_000,
        },
        {
          command: `NEXT_PUBLIC_CLAWBOARD_API_BASE=${mockApiBase} HOSTNAME=${loopbackHost} PORT=${webPort} pnpm run dev`,
          url: baseURL,
          reuseExistingServer: reuseServer,
          timeout: 120_000,
        },
      ],
});
