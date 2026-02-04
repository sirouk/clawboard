import { defineConfig } from "@playwright/test";
import path from "node:path";

const dataPath = path.join(process.cwd(), "tests", "fixtures", "portal.json");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3050",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `CLAWBOARD_FIXTURE_PATH=${dataPath} MOCK_API_PORT=3051 node tests/mock-api.mjs`,
      url: "http://localhost:3051/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `NEXT_PUBLIC_CLAWBOARD_API_BASE=http://localhost:3051 npm run build && NEXT_PUBLIC_CLAWBOARD_API_BASE=http://localhost:3051 PORT=3050 npm run start`,
      url: "http://localhost:3050",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
