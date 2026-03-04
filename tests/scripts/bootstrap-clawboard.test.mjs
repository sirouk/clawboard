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

async function makeOpenClawStub(binDir) {
  return makeStub(
    binDir,
    "openclaw",
    `
config_path="\${OPENCLAW_CONFIG_PATH:-\${OPENCLAW_HOME:-$HOME/.openclaw}/openclaw.json}"
openclaw_home="\${OPENCLAW_HOME:-$HOME/.openclaw}"
mkdir -p "$(dirname "$config_path")"

python3 - "$config_path" "$openclaw_home" <<'PY' >/dev/null 2>&1 || true
import json
import os
import sys

cfg_path = sys.argv[1]
home = os.path.abspath(os.path.expanduser(sys.argv[2]))
workspace = os.path.join(home, "workspace")

data = {}
if os.path.exists(cfg_path):
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
            if isinstance(parsed, dict):
                data = parsed
    except Exception:
        data = {}

agents = data.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
defaults.setdefault("workspace", workspace)
agent_list = agents.setdefault("list", [])
if not isinstance(agent_list, list):
    agent_list = []
    agents["list"] = agent_list

has_main = False
for item in agent_list:
    if isinstance(item, dict) and str(item.get("id", "")).strip().lower() == "main":
        has_main = True
        item.setdefault("workspace", workspace)
        if "default" not in item:
            item["default"] = True
        break

if not has_main:
    agent_list.insert(0, {"id": "main", "default": True, "workspace": workspace})

with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\\n")
PY

if [[ "$#" -ge 2 && "$1" == "doctor" && "$2" == "--fix" ]]; then
  exit 0
fi

if [[ "$#" -ge 3 && "$1" == "cron" && "$2" == "list" && "$3" == "--json" ]]; then
  echo '{"jobs":[]}'
  exit 0
fi

if [[ "$#" -ge 2 && "$1" == "memory" && "$2" == "index" ]]; then
  echo "Memory index updated."
  exit 0
fi

if [[ "$#" -ge 2 && "$1" == "memory" && "$2" == "status" ]]; then
  echo '{"provider":"local","healthy":true}'
  exit 0
fi

if [[ "$#" -ge 3 && "$1" == "config" && "$2" == "get" ]]; then
  key="$3"
  python3 - "$config_path" "$key" <<'PY'
import json
import sys

cfg_path, key = sys.argv[1], sys.argv[2]

try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}

cur = data
for part in [p for p in key.split(".") if p]:
    if isinstance(cur, dict):
        if part not in cur:
            print("null")
            raise SystemExit(0)
        cur = cur[part]
        continue
    if isinstance(cur, list) and part.isdigit():
        idx = int(part)
        if idx >= len(cur):
            print("null")
            raise SystemExit(0)
        cur = cur[idx]
        continue
    print("null")
    raise SystemExit(0)

print(json.dumps(cur, separators=(",", ":")))
PY
  exit 0
fi

if [[ "$#" -ge 4 && "$1" == "config" && "$2" == "set" ]]; then
  key="$3"
  value="$4"
  json_mode="false"
  if [[ "$#" -ge 5 && "$5" == "--json" ]]; then
    json_mode="true"
  fi
  if [[ -n "\${OPENCLAW_STUB_FAIL_SET_KEY:-}" && "$key" == "$OPENCLAW_STUB_FAIL_SET_KEY" ]]; then
    exit 1
  fi
  python3 - "$config_path" "$key" "$value" "$json_mode" <<'PY'
import json
import sys

cfg_path, key, raw_value, json_mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}

if json_mode == "true":
    value = json.loads(raw_value)
else:
    value = raw_value

parts = [p for p in key.split(".") if p]
if not parts:
    raise SystemExit(1)

cur = data
for idx, part in enumerate(parts):
    is_last = idx == len(parts) - 1
    next_part = parts[idx + 1] if not is_last else None
    want_list = bool(next_part and next_part.isdigit())

    if isinstance(cur, dict):
        if is_last:
            cur[part] = value
            break
        child = cur.get(part)
        if want_list:
            if not isinstance(child, list):
                child = []
                cur[part] = child
        else:
            if not isinstance(child, dict):
                child = {}
                cur[part] = child
        cur = child
        continue

    if isinstance(cur, list):
        if not part.isdigit():
            raise SystemExit(1)
        list_idx = int(part)
        while len(cur) <= list_idx:
            cur.append([] if want_list else {})
        if is_last:
            cur[list_idx] = value
            break
        child = cur[list_idx]
        if want_list:
            if not isinstance(child, list):
                child = []
                cur[list_idx] = child
        else:
            if not isinstance(child, dict):
                child = {}
                cur[list_idx] = child
        cur = child
        continue

    raise SystemExit(1)

with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\\n")
PY
  exit 0
fi

if [[ "$#" -ge 2 && "$1" == "plugins" ]]; then
  exit 0
fi

if [[ "$#" -ge 2 && "$1" == "gateway" ]]; then
  exit 0
fi

if [[ "$#" -ge 2 && "$1" == "devices" ]]; then
  if [[ "$#" -ge 3 && "$2" == "list" && "$3" == "--json" ]]; then
    echo '{"devices":[]}'
  fi
  exit 0
fi

exit 0
`
  );
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

  await makeOpenClawStub(binDir);
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
  assert.match(firstRun.stdout, /tools\.sessions\.visibility=all/i);
  assert.match(firstRun.stdout, /agents\.defaults\.sandbox\.sessionToolsVisibility=all/i);
  assert.match(firstRun.stdout, /tools\.agentToAgent\.enabled=true/i);

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

test("setup-openclaw-local-memory.sh: rolls back config snapshot on required write failure", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-memory-txn-"));
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "custom-openclaw-home");
  const binDir = path.join(tmp, "bin");
  const workspaceDir = path.join(openclawHome, "workspace");
  const configPath = path.join(openclawHome, "openclaw.json");
  const modelPath = path.join(tmp, "embeddinggemma-300M-Q8_0.gguf");

  await mkdir(homeDir, { recursive: true });
  await mkdir(openclawHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(modelPath, "stub-model");
  await makeOpenClawStub(binDir);

  const baselineConfig = {
    agents: {
      defaults: { workspace: workspaceDir },
      list: [{ id: "main", default: true, workspace: workspaceDir }],
    },
    memory: {
      backend: "qmd",
      qmd: {
        includeDefaultMemory: false,
        sessions: { enabled: true },
        limits: { maxResults: 4, timeoutMs: 1200 },
      },
    },
  };
  const baselineText = `${JSON.stringify(baselineConfig, null, 2)}\n`;
  await writeFile(configPath, baselineText);

  const env = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_MEMORY_MODEL_PATH: modelPath,
    OPENCLAW_MEMORY_INDEX_SCOPE: "main",
    OPENCLAW_CONFIG_FILE_FALLBACK: "0",
    OPENCLAW_STUB_FAIL_SET_KEY: "memory.qmd.limits.maxResults",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };

  const scriptPath = path.join(process.cwd(), "skills", "clawboard", "scripts", "setup-openclaw-local-memory.sh");
  const res = await run(["bash", scriptPath], { cwd: process.cwd(), env });

  assert.notEqual(res.code, 0, `expected failure exit code when required key write fails\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(`${res.stdout}\n${res.stderr}`, /Failed to set required config key: memory\.qmd\.limits\.maxResults/);

  const finalText = await readFile(configPath, "utf8");
  assert.equal(finalText, baselineText, "expected config to be rolled back to baseline snapshot after failure");
});

test("delegation supervision cadence stays aligned across templates and setup script", async () => {
  const root = process.cwd();
  const agentsPath = path.join(root, "agent-templates", "main", "AGENTS.md");
  const heartbeatPath = path.join(root, "agent-templates", "main", "HEARTBEAT.md");
  const soulPath = path.join(root, "agent-templates", "main", "SOUL.md");
  const setupPath = path.join(root, "skills", "clawboard", "scripts", "setup-openclaw-local-memory.sh");
  const bootstrapPath = path.join(root, "scripts", "bootstrap_clawboard.sh");
  const anatomyPath = path.join(root, "ANATOMY.md");
  const contextPath = path.join(root, "CONTEXT.md");
  const classificationPath = path.join(root, "CLASSIFICATION.md");

  const [agentsText, heartbeatText, soulText, setupText, bootstrapText, anatomyText, contextText, classificationText] =
    await Promise.all([
      readFile(agentsPath, "utf8"),
      readFile(heartbeatPath, "utf8"),
      readFile(soulPath, "utf8"),
      readFile(setupPath, "utf8"),
      readFile(bootstrapPath, "utf8"),
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
  assert.match(setupText, /memory\.backend=qmd.*memory-only source/i);
  assert.match(setupText, /memory\.qmd\.sessions\.enabled false json true/i);
  assert.match(agentsText, />5m|5 minutes/i);
  assert.match(heartbeatText, />5m|5 minutes/i);
  assert.match(bootstrapText, /openclaw_cfg_set_txn agents\.defaults\.memorySearch\.sources '\["memory"\]' json true/i);
  assert.match(bootstrapText, /openclaw_cfg_set_txn agents\.defaults\.memorySearch\.experimental\.sessionMemory false json true/i);

  assert.match(anatomyText, ladderPattern);
  assert.match(contextText, ladderPattern);
  assert.match(classificationText, ladderPattern);
});

test("main-agent execution lanes stay aligned across template, soul, and directive source", async () => {
  const root = process.cwd();
  const agentsPath = path.join(root, "agent-templates", "main", "AGENTS.md");
  const soulPath = path.join(root, "agent-templates", "main", "SOUL.md");
  const directivePath = path.join(root, "directives", "main", "GENERAL_CONTRACTOR.md");
  const readmePath = path.join(root, "README.md");

  const [agentsText, soulText, directiveText, readmeText] = await Promise.all([
    readFile(agentsPath, "utf8"),
    readFile(soulPath, "utf8"),
    readFile(directivePath, "utf8"),
    readFile(readmePath, "utf8"),
  ]);

  // Must preserve direct lane for trivially-answerable requests.
  assert.match(directiveText, /only execute directly/i);
  assert.match(agentsText, /main-only direct|trivial and faster than delegation/i);
  assert.match(soulText, /direct lane|trivial/i);

  // Must preserve single-specialist and multi-specialist/huddle lanes.
  assert.match(agentsText, /single-specialist|single specialist/i);
  assert.match(agentsText, /multi-specialist|huddle|federated/i);
  assert.match(directiveText, /delegate by default/i);
  assert.match(directiveText, /huddle|federated/i);

  // Routing tool contract must remain explicit.
  assert.match(agentsText, /sessions_spawn/i);
  assert.match(soulText, /sessions_spawn/i);
  assert.match(readmeText, /orchestration/i);
});
