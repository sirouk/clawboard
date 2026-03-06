import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, lstat, access, readFile, realpath } from "node:fs/promises";
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
stub_log_file="\${OPENCLAW_STUB_LOG_FILE:-}"
mkdir -p "$(dirname "$config_path")"

log_stub_call() {
  if [[ -n "$stub_log_file" ]]; then
    mkdir -p "$(dirname "$stub_log_file")"
    printf '%s\\n' "$*" >> "$stub_log_file"
  fi
}

plugin_has_base_url() {
  python3 - "$config_path" <<'PY'
import json
import sys

cfg_path = sys.argv[1]
try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    raise SystemExit(1)

plugins = data.get("plugins") or {}
entries = plugins.get("entries") if isinstance(plugins, dict) else {}
entry = entries.get("clawboard-logger") if isinstance(entries, dict) else {}
config = entry.get("config") if isinstance(entry, dict) else {}
base_url = config.get("baseUrl") if isinstance(config, dict) else ""
raise SystemExit(0 if str(base_url or "").strip() else 1)
PY
}

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
  log_stub_call "$*"
  if [[ -n "\${OPENCLAW_STUB_MEMORY_INDEX_OUTPUT:-}" ]]; then
    printf '%s\n' "$OPENCLAW_STUB_MEMORY_INDEX_OUTPUT"
  else
    echo "Memory index updated."
  fi
  exit "\${OPENCLAW_STUB_MEMORY_INDEX_RC:-0}"
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
  log_stub_call "$*"
  if [[ "$2" == "install" && "$#" -ge 4 && "$3" == "-l" ]]; then
    plugin_src="$4"
    plugin_dest="$openclaw_home/extensions/clawboard-logger"
    rm -rf "$plugin_dest"
    mkdir -p "$(dirname "$plugin_dest")"
    cp -R "$plugin_src" "$plugin_dest"
    exit 0
  fi
  if [[ "$2" == "enable" && "\${OPENCLAW_STUB_FAIL_PLUGIN_ENABLE_MISSING_BASEURL:-0}" == "1" ]]; then
    if ! plugin_has_base_url; then
      echo "[plugins] clawboard-logger invalid config: baseUrl: must have required property 'baseUrl'" >&2
      echo "[openclaw] Failed to start CLI: Error: Config validation failed: plugins.entries.clawboard-logger.config.baseUrl: invalid config: must have required property 'baseUrl'" >&2
      exit 1
    fi
  fi
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

async function makeTokenAwareCurlStub(binDir) {
  return makeStub(
    binDir,
    "curl",
    `
expected_token="\${CURL_STUB_EXPECTED_TOKEN:-}"
api_base="\${CURL_STUB_API_BASE:-http://localhost:8010}"
web_base="\${CURL_STUB_WEB_BASE:-http://localhost:3010}"
log_file="\${CURL_STUB_LOG_FILE:-}"
url=""
method="GET"
data=""
declare -a headers=()

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -H|--header)
      headers+=("$2")
      shift 2
      ;;
    -X|--request)
      method="$2"
      shift 2
      ;;
    -d|--data|--data-raw|--data-binary)
      data="$2"
      shift 2
      ;;
    -o|-w|--output|--write-out|--connect-timeout|--max-time|--retry|--retry-delay|--user-agent)
      shift 2
      ;;
    -f|-s|-S|-k|--fail|--silent|--show-error)
      shift
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

token_ok="0"
for header in "\${headers[@]}"; do
  if [[ "$header" == "X-Clawboard-Token: $expected_token" ]]; then
    token_ok="1"
    break
  fi
done

if [[ -n "$log_file" ]]; then
  mkdir -p "$(dirname "$log_file")"
  printf 'method=%s url=%s token=%s data=%s\\n' "$method" "$url" "$token_ok" "$data" >> "$log_file"
fi

if [[ "$url" == "$api_base/api/health" || "$url" == "$api_base/api/config" ]]; then
  if [[ "$token_ok" == "1" ]]; then
    exit 0
  fi
  exit 22
fi

if [[ "$url" == "$web_base" ]]; then
  exit 0
fi

exit 0
`
  );
}

async function seedBootstrapInstallTree(installDir, { includePlugin = true } = {}) {
  await mkdir(path.join(installDir, ".git"), { recursive: true });
  await mkdir(path.join(installDir, "skills", "clawboard"), { recursive: true });
  await writeFile(path.join(installDir, "skills", "clawboard", "SKILL.md"), "name: clawboard\n");
  await mkdir(path.join(installDir, "agent-templates", "main"), { recursive: true });

  if (includePlugin) {
    await mkdir(path.join(installDir, "extensions", "clawboard-logger"), { recursive: true });
    await writeFile(path.join(installDir, "extensions", "clawboard-logger", "index.js"), "export default {};\n");
    await writeFile(
      path.join(installDir, "extensions", "clawboard-logger", "openclaw.plugin.json"),
      '{ "id": "clawboard-logger", "schema": { "type": "object" } }\n'
    );
  }

  const templateFiles = ["AGENTS.md", "SOUL.md", "HEARTBEAT.md", "BOOTSTRAP.md"];
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

  return { templateFiles, contractDocs };
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
  const { templateFiles, contractDocs } = await seedBootstrapInstallTree(installDir);

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
  assert.equal(await realpath(installedSkill), await realpath(path.join(installDir, "skills", "clawboard")));

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

test("bootstrap_clawboard.sh: uses CLAWBOARD_TOKEN for API health and config writes", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-auth-"));
  const repoRoot = path.join(tmp, "repo");
  const installDir = path.join(tmp, "install");
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "openclaw-home");
  const binDir = path.join(tmp, "bin");
  const curlLogPath = path.join(tmp, "curl.log");

  await mkdir(repoRoot, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(openclawHome, "workspace"), { recursive: true });
  await seedBootstrapInstallTree(installDir, { includePlugin: false });

  await makeOpenClawStub(binDir);
  await makeTokenAwareCurlStub(binDir);

  const bootstrapPath = path.join(repoRoot, "scripts");
  await mkdir(bootstrapPath, { recursive: true });
  await cp(path.join(process.cwd(), "scripts", "bootstrap_clawboard.sh"), path.join(bootstrapPath, "bootstrap_clawboard.sh"));
  await cp(path.join(process.cwd(), "scripts", "bootstrap_openclaw.sh"), path.join(bootstrapPath, "bootstrap_openclaw.sh"));

  const env = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_HOME: openclawHome,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CLAWBOARD_TOKEN: "auth-token",
    CURL_STUB_EXPECTED_TOKEN: "auth-token",
    CURL_STUB_LOG_FILE: curlLogPath,
  };

  const res = await run(
    [
      "bash",
      path.join(bootstrapPath, "bootstrap_clawboard.sh"),
      "--dir",
      installDir,
      "--skip-docker",
      "--skip-plugin",
      "--skip-memory-backup-setup",
      "--no-access-url-prompt",
      "--no-color",
      "--integration-level",
      "write",
    ],
    { cwd: repoRoot, env }
  );

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /Clawboard API is reachable at http:\/\/localhost:8010\/api\/health/);
  assert.match(res.stdout, /Clawboard config set: title=Clawboard, integrationLevel=write\./);
  assert.doesNotMatch(res.stdout, /Skipping \/api\/config update until API is reachable/);

  const curlLog = await readFile(curlLogPath, "utf8");
  assert.match(curlLog, /url=http:\/\/localhost:8010\/api\/health token=1/);
  assert.match(curlLog, /method=POST url=http:\/\/localhost:8010\/api\/config token=1/);
});

test("bootstrap_clawboard.sh: does not report memory index success when qmd/sqlite errors appear in output", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-index-errors-"));
  const repoRoot = path.join(tmp, "repo");
  const installDir = path.join(tmp, "install");
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "openclaw-home");
  const binDir = path.join(tmp, "bin");

  await mkdir(repoRoot, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(openclawHome, "workspace"), { recursive: true });
  await seedBootstrapInstallTree(installDir, { includePlugin: false });

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
    CLAWBOARD_TOKEN: "index-token",
    OPENCLAW_STUB_MEMORY_INDEX_OUTPUT:
      "SqliteError: constraint failed\ncode: SQLITE_CONSTRAINT_PRIMARYKEY\nNode.js v25.5.0",
    OPENCLAW_STUB_MEMORY_INDEX_RC: "0",
  };

  const res = await run(
    [
      "bash",
      path.join(bootstrapPath, "bootstrap_clawboard.sh"),
      "--dir",
      installDir,
      "--skip-docker",
      "--skip-plugin",
      "--skip-memory-backup-setup",
      "--no-access-url-prompt",
      "--no-color",
      "--integration-level",
      "write",
    ],
    { cwd: repoRoot, env }
  );

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /Agent 'main' memory index refreshed\./);
  assert.match(res.stdout, /Agent 'main' index output reported qmd\/sqlite errors/);
  assert.match(res.stdout, /QMD memory index refresh completed with 1 warning\(s\)\./);
});

test("bootstrap_clawboard.sh: deploys logger plugin directly so required baseUrl config can be written before activation", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-plugin-"));
  const repoRoot = path.join(tmp, "repo");
  const installDir = path.join(tmp, "install");
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "openclaw-home");
  const binDir = path.join(tmp, "bin");
  const configPath = path.join(openclawHome, "openclaw.json");
  const openclawLogPath = path.join(tmp, "openclaw.log");

  await mkdir(repoRoot, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(openclawHome, "workspace"), { recursive: true });
  await seedBootstrapInstallTree(installDir, { includePlugin: true });

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
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STUB_FAIL_PLUGIN_ENABLE_MISSING_BASEURL: "1",
    OPENCLAW_STUB_LOG_FILE: openclawLogPath,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CLAWBOARD_TOKEN: "plugin-token",
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
    { cwd: repoRoot, env }
  );

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /Failed installing clawboard-logger plugin atomically/);
  assert.match(res.stdout, /Logger plugin installed and enabled\./);

  let openclawLog = "";
  try {
    openclawLog = await readFile(openclawLogPath, "utf8");
  } catch (error) {
    assert.equal(error && typeof error === "object" && "code" in error ? error.code : "", "ENOENT");
  }
  assert.doesNotMatch(openclawLog, /plugins install -l/);
  assert.doesNotMatch(openclawLog, /plugins enable clawboard-logger/);

  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.plugins.entries["clawboard-logger"].enabled, true);
  assert.equal(config.plugins.entries["clawboard-logger"].config.baseUrl, "http://localhost:8010");

  const installedPluginPath = path.join(openclawHome, "extensions", "clawboard-logger");
  const installedPluginStats = await lstat(installedPluginPath);
  assert.equal(installedPluginStats.isDirectory(), true, "expected logger plugin directory to be installed");
});

test("bootstrap_clawboard.sh: avoids duplicate memory reindex after Obsidian setup", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-obsidian-index-"));
  const repoRoot = path.join(tmp, "repo");
  const installDir = path.join(tmp, "install");
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "openclaw-home");
  const binDir = path.join(tmp, "bin");
  const openclawLogPath = path.join(tmp, "openclaw.log");
  const localMemoryLogPath = path.join(tmp, "local-memory.log");
  const obsidianLogPath = path.join(tmp, "obsidian.log");

  await mkdir(repoRoot, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(openclawHome, "workspace"), { recursive: true });
  await seedBootstrapInstallTree(installDir, { includePlugin: false });

  await mkdir(path.join(installDir, "skills", "clawboard", "scripts"), { recursive: true });
  await writeFile(
    path.join(installDir, "skills", "clawboard", "scripts", "setup-openclaw-local-memory.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "skip=\${OPENCLAW_MEMORY_SKIP_INDEX:-}" >> "\${LOCAL_MEMORY_SETUP_LOG_FILE}"
`,
    { mode: 0o755 }
  );

  await mkdir(path.join(installDir, "scripts"), { recursive: true });
  await writeFile(
    path.join(installDir, "scripts", "setup_obsidian_brain.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "obsidian-ran" >> "\${OBSIDIAN_SETUP_LOG_FILE}"
openclaw memory index --agent main --force
`,
    { mode: 0o755 }
  );

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
    OPENCLAW_STUB_LOG_FILE: openclawLogPath,
    LOCAL_MEMORY_SETUP_LOG_FILE: localMemoryLogPath,
    OBSIDIAN_SETUP_LOG_FILE: obsidianLogPath,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CLAWBOARD_TOKEN: "obsidian-token",
  };

  const res = await run(
    [
      "bash",
      path.join(bootstrapPath, "bootstrap_clawboard.sh"),
      "--dir",
      installDir,
      "--skip-docker",
      "--skip-plugin",
      "--skip-memory-backup-setup",
      "--setup-obsidian-memory",
      "--no-access-url-prompt",
      "--no-color",
      "--integration-level",
      "write",
    ],
    { cwd: repoRoot, env }
  );

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(
    res.stdout,
    /Skipping bootstrap QMD refresh because setup_obsidian_brain\.sh already refreshed indexes\./
  );

  const localMemoryLog = await readFile(localMemoryLogPath, "utf8");
  assert.match(localMemoryLog, /skip=true/);

  const obsidianLog = await readFile(obsidianLogPath, "utf8");
  assert.match(obsidianLog, /obsidian-ran/);

  const openclawLog = await readFile(openclawLogPath, "utf8");
  const memoryIndexCalls = openclawLog
    .split("\n")
    .filter((line) => line.trim() === "memory index --agent main --force");
  assert.equal(memoryIndexCalls.length, 1, `expected one memory index call, saw:\n${openclawLog}`);
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
