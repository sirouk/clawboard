import { defineConfig } from "@playwright/test";
import path from "node:path";

const dataPath = path.join(process.cwd(), "tests", "fixtures", "portal.json");
const reuseServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1" && !process.env.CI;
const useExternalServer = process.env.PLAYWRIGHT_USE_EXTERNAL_SERVER === "1";
const mockApiPort = Number(process.env.PLAYWRIGHT_MOCK_API_PORT ?? "3051");
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? "3050");
const mockApiBase = `http://localhost:${mockApiPort}`;
const mockBaseURL = `http://localhost:${webPort}`;
const externalApiBase = process.env.PLAYWRIGHT_EXTERNAL_API_BASE ?? "http://localhost:8010";
const externalBaseURL = process.env.PLAYWRIGHT_EXTERNAL_BASE_URL ?? "http://localhost:3010";
const apiBase = process.env.PLAYWRIGHT_API_BASE ?? (useExternalServer ? externalApiBase : mockApiBase);
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ?? (useExternalServer ? externalBaseURL : mockBaseURL);

if (!process.env.PLAYWRIGHT_API_BASE) process.env.PLAYWRIGHT_API_BASE = apiBase;
if (!process.env.PLAYWRIGHT_BASE_URL) process.env.PLAYWRIGHT_BASE_URL = baseURL;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    trace: "on-first-retry",
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
          command: `NEXT_PUBLIC_CLAWBOARD_API_BASE=${mockApiBase} NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN= npm run build && NEXT_PUBLIC_CLAWBOARD_API_BASE=${mockApiBase} NEXT_PUBLIC_CLAWBOARD_DEFAULT_TOKEN= PORT=${webPort} npm run start`,
          url: baseURL,
          reuseExistingServer: reuseServer,
          timeout: 120_000,
        },
      ],
});
