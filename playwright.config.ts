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
  webServer: {
    command: `CLAWBOARD_DATA_PATH=${dataPath} npm run build && CLAWBOARD_DATA_PATH=${dataPath} PORT=3050 npm run start`,
    url: "http://localhost:3050",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
