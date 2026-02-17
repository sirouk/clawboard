import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, lstat, readlink, access } from "node:fs/promises";
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

async function makeStub(binDir, name, scriptBody) {
  const filePath = path.join(binDir, name);
  const contents = `#!/usr/bin/env bash
set -euo pipefail
${scriptBody}
`;
  await writeFile(filePath, contents, { mode: 0o755 });
  return filePath;
}

test("bootstrap_openclaw.sh: wrapper delegates to bootstrap_clawboard.sh help", async () => {
  const res = await run(["bash", "scripts/bootstrap_openclaw.sh", "--help"], {
    cwd: process.cwd(),
    env: process.env,
  });

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /Usage: bash scripts\/bootstrap_clawboard\.sh/);
});

test("bootstrap_clawboard.sh: unknown option fails fast", async () => {
  const res = await run(["bash", "scripts/bootstrap_clawboard.sh", "--definitely-not-a-real-flag", "--no-color"], {
    cwd: process.cwd(),
    env: process.env,
  });

  assert.notEqual(res.code, 0);
  assert.match(`${res.stdout}\n${res.stderr}`, /Unknown option: --definitely-not-a-real-flag/);
});

test("bootstrap_clawboard.sh: installs skill into OPENCLAW_HOME/skills when set", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-"));
  const repoRoot = path.join(tmp, "repo");
  const installDir = path.join(tmp, "install");
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "custom-openclaw-home");
  const binDir = path.join(tmp, "bin");

  await mkdir(repoRoot, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  await mkdir(path.join(installDir, ".git"), { recursive: true });
  await mkdir(path.join(installDir, "skills", "clawboard"), { recursive: true });
  await writeFile(path.join(installDir, "skills", "clawboard", "SKILL.md"), "name: clawboard\n");
  await mkdir(path.join(installDir, "extensions", "clawboard-logger"), { recursive: true });

  await makeStub(
    binDir,
    "openclaw",
    `
if [[ "$#" -ge 3 && "$1" == "config" && "$2" == "get" && "$3" == "gateway.http.endpoints.responses.enabled" ]]; then
  echo "false"
  exit 0
fi
if [[ "$#" -ge 3 && "$1" == "cron" && "$2" == "list" && "$3" == "--json" ]]; then
  echo '{"jobs":[]}'
  exit 0
fi
exit 0
`
  );
  await makeStub(binDir, "curl", "exit 0");

  const bootstrapPath = path.join(repoRoot, "scripts");
  await mkdir(bootstrapPath, { recursive: true });
  await cp(path.join(process.cwd(), "scripts", "bootstrap_clawboard.sh"), path.join(bootstrapPath, "bootstrap_clawboard.sh"));
  await cp(path.join(process.cwd(), "scripts", "bootstrap_openclaw.sh"), path.join(bootstrapPath, "bootstrap_openclaw.sh"));

  const env = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_HOME: openclawHome,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CLAWBOARD_TOKEN: "test-token",
  };

  const res = await run(
    [
      "bash",
      path.join(bootstrapPath, "bootstrap_clawboard.sh"),
      "--dir",
      installDir,
      "--skip-docker",
      "--skip-memory-backup-setup",
      "--no-access-url-prompt",
      "--no-color",
      "--integration-level",
      "write",
    ],
    {
      cwd: repoRoot,
      env,
    }
  );

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const installedSkill = path.join(openclawHome, "skills", "clawboard");
  const skillStats = await lstat(installedSkill);
  assert.equal(skillStats.isSymbolicLink(), true, "expected clawboard skill install to be a symlink");
  assert.equal(await readlink(installedSkill), path.join(installDir, "skills", "clawboard"));

  const legacySkillPath = path.join(homeDir, ".openclaw", "skills", "clawboard");
  await assert.rejects(access(legacySkillPath));
});
