import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, lstat, readlink, access, readFile } from "node:fs/promises";
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

test("bootstrap_clawboard.sh: installs skill into OPENCLAW_HOME/skills when set and stays idempotent on rerun", async () => {
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
  await mkdir(path.join(openclawHome, "workspace"), { recursive: true });

  await mkdir(path.join(installDir, ".git"), { recursive: true });
  await mkdir(path.join(installDir, "skills", "clawboard"), { recursive: true });
  await writeFile(path.join(installDir, "skills", "clawboard", "SKILL.md"), "name: clawboard\n");
  await mkdir(path.join(installDir, "extensions", "clawboard-logger"), { recursive: true });
  await mkdir(path.join(installDir, "agent-templates", "main"), { recursive: true });

  const templateFiles = ["AGENTS.md", "SOUL.md", "HEARTBEAT.md"];
  for (const fileName of templateFiles) {
    await writeFile(path.join(installDir, "agent-templates", "main", fileName), `${fileName} from install source\n`);
  }

  const contractDocs = [
    "ANATOMY.md",
    "CONTEXT.md",
    "CLASSIFICATION.md",
    "CONTEXT_SPEC.md",
    "CLASSIFICATION_TEST_MATRIX.md",
    "OPENCLAW_CLAWBOARD_UML.md",
    "TESTING.md",
  ];
  for (const doc of contractDocs) {
    await writeFile(path.join(installDir, doc), `${doc} from install source\n`);
  }

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

  const bootstrapArgs = [
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
  ];

  const firstRun = await run(bootstrapArgs, {
    cwd: repoRoot,
    env,
  });
  assert.equal(firstRun.code, 0, `exit=${firstRun.code}\nstdout:\n${firstRun.stdout}\nstderr:\n${firstRun.stderr}`);

  const secondRun = await run(bootstrapArgs, {
    cwd: repoRoot,
    env,
  });
  assert.equal(secondRun.code, 0, `exit=${secondRun.code}\nstdout:\n${secondRun.stdout}\nstderr:\n${secondRun.stderr}`);

  const mainWorkspace = path.join(openclawHome, "workspace");
  for (const fileName of templateFiles) {
    const sourceText = await readFile(path.join(installDir, "agent-templates", "main", fileName), "utf8");
    const deployedText = await readFile(path.join(mainWorkspace, fileName), "utf8");
    assert.equal(deployedText, sourceText, `expected ${fileName} to match install source after bootstrap`);
  }
  for (const doc of contractDocs) {
    const sourceText = await readFile(path.join(installDir, doc), "utf8");
    const deployedText = await readFile(path.join(mainWorkspace, doc), "utf8");
    assert.equal(deployedText, sourceText, `expected ${doc} to match install source after bootstrap`);
  }

  const installedSkill = path.join(openclawHome, "skills", "clawboard");
  const skillStats = await lstat(installedSkill);
  assert.equal(skillStats.isSymbolicLink(), true, "expected clawboard skill install to be a symlink");
  assert.equal(await readlink(installedSkill), path.join(installDir, "skills", "clawboard"));

  const legacySkillPath = path.join(homeDir, ".openclaw", "skills", "clawboard");
  await assert.rejects(access(legacySkillPath));

  const envPath = path.join(installDir, ".env");
  const envText = await readFile(envPath, "utf8");
  const envLines = envText.split(/\r?\n/);
  const singleEntryKeys = [
    "OPENCLAW_REQUEST_ID_MAX_ENTRIES",
    "OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS",
    "OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES",
    "CLAWBOARD_SEARCH_INCLUDE_TOOL_CALL_LOGS",
    "CLAWBOARD_VECTOR_INCLUDE_TOOL_CALL_LOGS",
    "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TOPICS",
    "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_TASKS",
    "CLAWBOARD_SEARCH_EFFECTIVE_LIMIT_LOGS",
  ];
  for (const key of singleEntryKeys) {
    const count = envLines.filter((line) => line.startsWith(`${key}=`)).length;
    assert.equal(count, 1, `expected ${key} to be written exactly once after rerun, found ${count}`);
  }
});

test("delegation supervision cadence stays aligned across templates and setup script", async () => {
  const root = process.cwd();
  const agentsPath = path.join(root, "agent-templates", "main", "AGENTS.md");
  const heartbeatPath = path.join(root, "agent-templates", "main", "HEARTBEAT.md");
  const soulPath = path.join(root, "agent-templates", "main", "SOUL.md");
  const setupPath = path.join(root, "skills", "clawboard", "scripts", "setup-openclaw-local-memory.sh");
  const anatomyPath = path.join(root, "ANATOMY.md");
  const contextPath = path.join(root, "CONTEXT.md");
  const classificationPath = path.join(root, "CLASSIFICATION.md");

  const [agentsText, heartbeatText, soulText, setupText, anatomyText, contextText, classificationText] =
    await Promise.all([
      readFile(agentsPath, "utf8"),
      readFile(heartbeatPath, "utf8"),
      readFile(soulPath, "utf8"),
      readFile(setupPath, "utf8"),
      readFile(anatomyPath, "utf8"),
      readFile(contextPath, "utf8"),
      readFile(classificationPath, "utf8"),
    ]);

  const ladderPattern =
    /(1m\s*(?:-|=)?>\s*3m\s*(?:-|=)?>\s*10m\s*(?:-|=)?>\s*15m\s*(?:-|=)?>\s*30m\s*(?:-|=)?>\s*1h|\[?\s*1m\s*,\s*3m\s*,\s*10m\s*,\s*15m\s*,\s*30m\s*,\s*1h\s*\]?)/i;
  assert.match(agentsText, ladderPattern);
  assert.match(heartbeatText, ladderPattern);
  assert.match(soulText, ladderPattern);
  assert.match(setupText, ladderPattern);

  assert.match(setupText, /heartbeat\.every"\s*"5m"/i);
  assert.match(setupText, /still active beyond 5 minutes/i);
  assert.match(setupText, /memoryFlush\.enabled true json false/i);
  assert.match(agentsText, />5m|5 minutes/i);
  assert.match(heartbeatText, />5m|5 minutes/i);

  assert.match(anatomyText, ladderPattern);
  assert.match(contextText, ladderPattern);
  assert.match(classificationText, ladderPattern);
});
