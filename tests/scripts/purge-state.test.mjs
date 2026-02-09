import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function run(cmd, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function makeStub(binDir, name, logPath) {
  const filePath = path.join(binDir, name);
  const contents = `#!/usr/bin/env bash
set -euo pipefail
echo "${name} $*" >> "${logPath}"
exit 0
`;
  await writeFile(filePath, contents, { mode: 0o755 });
  return filePath;
}

async function listDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

test("purge-state.sh: brings down clawboard before stopping gateway; ends with doctor then bring up", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-purge-"));
  const repoRoot = path.join(tmp, "repo");
  const homeDir = path.join(tmp, "home");
  const binDir = path.join(tmp, "bin");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  // Copy script into a temp "repo root" so APPLY mode is safe.
  await cp(path.join(process.cwd(), "purge-state.sh"), path.join(repoRoot, "purge-state.sh"));
  await writeFile(path.join(repoRoot, "docker-compose.yaml"), "services: {}\n");
  await writeFile(path.join(repoRoot, ".env"), "CLAWBOARD_WEB_HOT_RELOAD=false\n");

  // Seed fake state to be archived.
  const openclawDir = path.join(homeDir, ".openclaw");
  await mkdir(path.join(openclawDir, "workspace-main"), { recursive: true });
  await mkdir(path.join(openclawDir, "agents", "main", "sessions"), { recursive: true });
  await writeFile(path.join(openclawDir, "agents", "main", "sessions", "sessions.json"), "{}\n");
  await mkdir(path.join(openclawDir, "memory"), { recursive: true });
  await writeFile(path.join(openclawDir, "memory", "m.sqlite"), "fake\n");
  await writeFile(path.join(openclawDir, "clawboard-queue.sqlite"), "queue\n");

  const clawdRepo = path.join(homeDir, "clawd");
  await mkdir(path.join(clawdRepo, "_purged"), { recursive: true });
  await writeFile(path.join(clawdRepo, "_purged", "x.txt"), "x\n");

  await mkdir(path.join(repoRoot, "data"), { recursive: true });
  await writeFile(path.join(repoRoot, "data", "db.sqlite"), "db\n");

  const stubLog = path.join(tmp, "stub.log");
  await writeFile(stubLog, "");
  await makeStub(binDir, "docker", stubLog);
  await makeStub(binDir, "openclaw", stubLog);
  await makeStub(binDir, "curl", stubLog);

  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };

  const result = await run(["bash", path.join(repoRoot, "purge-state.sh"), "--apply", "--force"], {
    cwd: repoRoot,
    env,
  });
  assert.equal(result.code, 0, `exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const archiveRoot = path.join(repoRoot, "_purge-archive");
  const archives = await listDirs(archiveRoot);
  assert.equal(archives.length, 1, `expected 1 archive dir, got: ${archives.join(", ")}`);
  const archiveDir = path.join(archiveRoot, archives[0]);

  // Ensure state was moved into archive (not deleted).
  assert.equal(await stat(path.join(archiveDir, "workspace-main")).then(() => true).catch(() => false), true);
  assert.equal(
    await stat(path.join(archiveDir, "openclaw-agent-sessions", "main", "sessions")).then(() => true).catch(() => false),
    true
  );
  assert.equal(await stat(path.join(archiveDir, "openclaw-memory", "m.sqlite")).then(() => true).catch(() => false), true);
  assert.equal(await stat(path.join(archiveDir, "clawboard-queue.sqlite")).then(() => true).catch(() => false), true);
  assert.equal(await stat(path.join(archiveDir, "data")).then(() => true).catch(() => false), true);
  assert.equal(await stat(path.join(archiveDir, "_purged")).then(() => true).catch(() => false), true);

  const calls = (await readFile(stubLog, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const idx = (needle) => {
    const i = calls.findIndex((line) => line.includes(needle));
    assert.ok(i >= 0, `missing call: ${needle}\nCalls:\n${calls.join("\n")}`);
    return i;
  };

  // Docker compose down should happen before stopping the gateway.
  const dockerDown = idx("docker compose down -v --remove-orphans");
  const gatewayStop = idx("openclaw gateway stop");
  assert.ok(dockerDown < gatewayStop, "expected clawboard_down to run before gateway stop");

  // Gateway start then doctor, then docker compose up at the end.
  const gatewayStart = idx("openclaw gateway start");
  const doctorFix = idx("openclaw doctor --fix");
  const dockerUp = idx("docker compose up -d");
  assert.ok(gatewayStart < doctorFix, "expected gateway start before doctor --fix");
  assert.ok(doctorFix < dockerUp, "expected doctor --fix before clawboard_up");
});

test("purge-state.sh: hot reload mode uses dev profile and web-dev service", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-purge-hot-"));
  const repoRoot = path.join(tmp, "repo");
  const homeDir = path.join(tmp, "home");
  const binDir = path.join(tmp, "bin");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  await cp(path.join(process.cwd(), "purge-state.sh"), path.join(repoRoot, "purge-state.sh"));
  await writeFile(path.join(repoRoot, "docker-compose.yaml"), "services: {}\n");
  await writeFile(path.join(repoRoot, ".env"), "CLAWBOARD_WEB_HOT_RELOAD=true\n");

  const openclawDir = path.join(homeDir, ".openclaw");
  await mkdir(path.join(openclawDir, "workspace-main"), { recursive: true });
  await mkdir(path.join(repoRoot, "data"), { recursive: true });

  const stubLog = path.join(tmp, "stub.log");
  await writeFile(stubLog, "");
  await makeStub(binDir, "docker", stubLog);
  await makeStub(binDir, "openclaw", stubLog);
  await makeStub(binDir, "curl", stubLog);

  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };

  const result = await run(["bash", path.join(repoRoot, "purge-state.sh"), "--apply", "--force"], {
    cwd: repoRoot,
    env,
  });
  assert.equal(result.code, 0, `exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const calls = (await readFile(stubLog, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  assert.ok(
    calls.some((line) => line.includes("docker compose --profile dev up -d api classifier qdrant web-dev")),
    `expected dev profile up to include web-dev.\nCalls:\n${calls.join("\n")}`
  );
  assert.ok(
    calls.some((line) => line.includes("docker compose stop web")),
    `expected prod web to be stopped in hot reload mode.\nCalls:\n${calls.join("\n")}`
  );
});

