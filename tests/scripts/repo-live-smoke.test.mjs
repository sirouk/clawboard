import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function run(cmd, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function makeStub(binDir, name, scriptBody) {
  const filePath = path.join(binDir, name);
  const contents = `#!/usr/bin/env bash
set -euo pipefail
${scriptBody}
`;
  await writeFile(filePath, contents, { mode: 0o755 });
  return filePath;
}

test("repo_live_smoke prefers local stack origins when available", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-live-smoke-local-"));
  const binDir = path.join(tmp, "bin");
  await mkdir(binDir, { recursive: true });

  const envFile = path.join(tmp, ".env");
  const logPath = path.join(tmp, "playwright.log");
  await writeFile(
    envFile,
    [
      "CLAWBOARD_TOKEN=test-token",
      "CLAWBOARD_PUBLIC_API_BASE=http://100.91.119.30:8010",
      "CLAWBOARD_PUBLIC_WEB_URL=http://100.91.119.30:3010",
    ].join("\n"),
  );

  await makeStub(
    binDir,
    "curl",
    `
url="\${@: -1}"
if [[ "$url" == "http://127.0.0.1:8010/api/health" || "$url" == "http://127.0.0.1:3010/u" ]]; then
  exit 0
fi
exit 7
`,
  );

  await makeStub(
    binDir,
    "playwright",
    `
printf 'API=%s\\nBASE=%s\\nTOKEN=%s\\nEXTERNAL=%s\\nLIVE=%s\\nARGS=%s\\n' \
  "\${PLAYWRIGHT_API_BASE:-}" \
  "\${PLAYWRIGHT_BASE_URL:-}" \
  "\${PLAYWRIGHT_CLAWBOARD_TOKEN:-}" \
  "\${PLAYWRIGHT_USE_EXTERNAL_SERVER:-}" \
  "\${PLAYWRIGHT_LIVE_STACK_SMOKE:-}" \
  "$*" > "${logPath}"
`,
  );

  const result = await run(["bash", "scripts/repo_live_smoke.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CLAWBOARD_ENV_FILE: envFile,
    },
  });

  assert.equal(result.code, 0, `exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const log = await readFile(logPath, "utf8");
  assert.match(log, /API=http:\/\/127\.0\.0\.1:8010/);
  assert.match(log, /BASE=http:\/\/127\.0\.0\.1:3010/);
  assert.match(log, /TOKEN=test-token/);
  assert.match(log, /EXTERNAL=1/);
  assert.match(log, /LIVE=1/);
});

test("repo_live_smoke falls back to repo public origins when local stack is unavailable", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-live-smoke-remote-"));
  const binDir = path.join(tmp, "bin");
  await mkdir(binDir, { recursive: true });

  const envFile = path.join(tmp, ".env");
  const logPath = path.join(tmp, "playwright.log");
  await writeFile(
    envFile,
    [
      "CLAWBOARD_TOKEN=test-token",
      "CLAWBOARD_PUBLIC_API_BASE=http://100.91.119.30:8010",
      "CLAWBOARD_PUBLIC_WEB_URL=http://100.91.119.30:3010",
    ].join("\n"),
  );

  await makeStub(binDir, "curl", "exit 7");
  await makeStub(
    binDir,
    "playwright",
    `
printf 'API=%s\\nBASE=%s\\nTOKEN=%s\\n' \
  "\${PLAYWRIGHT_API_BASE:-}" \
  "\${PLAYWRIGHT_BASE_URL:-}" \
  "\${PLAYWRIGHT_CLAWBOARD_TOKEN:-}" > "${logPath}"
`,
  );

  const result = await run(["bash", "scripts/repo_live_smoke.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CLAWBOARD_ENV_FILE: envFile,
    },
  });

  assert.equal(result.code, 0, `exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const log = await readFile(logPath, "utf8");
  assert.match(log, /API=http:\/\/100\.91\.119\.30:8010/);
  assert.match(log, /BASE=http:\/\/100\.91\.119\.30:3010/);
  assert.match(log, /TOKEN=test-token/);
});
