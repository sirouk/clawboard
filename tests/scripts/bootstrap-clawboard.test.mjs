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

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

fail_if_discovered_plugin_missing_base_url() {
  local plugin_dest="$openclaw_home/extensions/clawboard-logger"
  if [[ "\${OPENCLAW_STUB_FAIL_ANY_COMMAND_MISSING_BASEURL:-0}" != "1" ]]; then
    return 0
  fi
  if [[ ! -d "$plugin_dest" ]]; then
    return 0
  fi
  if plugin_has_base_url; then
    return 0
  fi
  echo "[plugins] clawboard-logger invalid config: baseUrl: must have required property 'baseUrl'" >&2
  echo "[openclaw] Failed to start CLI: Error: Config validation failed: plugins.entries.clawboard-logger.config.baseUrl: invalid config: must have required property 'baseUrl'" >&2
  exit 1
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

fail_if_discovered_plugin_missing_base_url

if [[ "$#" -ge 3 && "$1" == "config" && "$2" == "get" ]]; then
  key="$3"
  if [[ "$key" == "gateway.auth.token" && "\${OPENCLAW_STUB_REDACT_GATEWAY_TOKEN:-0}" == "1" ]]; then
    echo '"__OPENCLAW_REDACTED__"'
    exit 0
  fi
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

if [[ "$#" -ge 3 && "$1" == "agents" && "$2" == "add" ]]; then
  agent_id="$3"
  shift 3
  workspace=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --workspace)
        workspace="$2"
        shift 2
        ;;
      --non-interactive|--yes)
        shift
        ;;
      *)
        shift
        ;;
    esac
  done
  python3 - "$config_path" "$agent_id" "$workspace" <<'PY'
import json
import sys

cfg_path, agent_id, workspace = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    with open(cfg_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}

agents = data.setdefault("agents", {})
agent_list = agents.setdefault("list", [])
if not isinstance(agent_list, list):
    agent_list = []
    agents["list"] = agent_list

existing = None
for entry in agent_list:
    if isinstance(entry, dict) and str(entry.get("id") or "").strip().lower() == agent_id.strip().lower():
        existing = entry
        break

if existing is None:
    existing = {"id": agent_id}
    agent_list.append(existing)

if workspace:
    existing["workspace"] = workspace

with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\\n")
PY
  log_stub_call "agents add $agent_id --workspace $workspace"
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

async function makeTailscaleStub(
  binDir,
  {
    dnsName = "test-host.tail77f45e.ts.net.",
    certDomain = "test-host.tail77f45e.ts.net",
    ip = "100.64.12.34",
  } = {}
) {
  const statusJson = JSON.stringify({
    Self: { DNSName: dnsName },
    CertDomains: [certDomain],
  });
  return makeStub(
    binDir,
    "tailscale",
    `
stub_log_file="\${TAILSCALE_STUB_LOG_FILE:-}"

log_stub_call() {
  if [[ -n "$stub_log_file" ]]; then
    mkdir -p "$(dirname "$stub_log_file")"
    printf '%s\\n' "$*" >> "$stub_log_file"
  fi
}

if [[ "$#" -ge 2 && "$1" == "status" && "$2" == "--json" ]]; then
  printf '%s\\n' '${statusJson}'
  exit 0
fi
if [[ "$#" -ge 2 && "$1" == "ip" && "$2" == "-4" ]]; then
  printf '%s\\n' '${ip}'
  exit 0
fi
if [[ "$#" -ge 4 && "$1" == "serve" && "$2" == "--bg" && "$3" == --https=* ]]; then
  log_stub_call "$*"
  exit 0
fi
exit 1
`
  );
}

async function seedBootstrapInstallTree(installDir, { includePlugin = true, includeSpecialists = false } = {}) {
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

  if (includeSpecialists) {
    await mkdir(path.join(installDir, "scripts"), { recursive: true });
    await cp(
      path.join(process.cwd(), "scripts", "setup_specialist_agents.sh"),
      path.join(installDir, "scripts", "setup_specialist_agents.sh")
    );
    for (const agentId of ["coding", "docs", "web", "social"]) {
      const templateDir = path.join(installDir, "agent-templates", agentId);
      await mkdir(templateDir, { recursive: true });
      await writeFile(path.join(templateDir, "AGENTS.md"), `# ${agentId} AGENTS\n`);
      await writeFile(path.join(templateDir, "SOUL.md"), `# ${agentId} SOUL\n`);
    }
  }

  const contractDocs = [
    "ANATOMY.md",
    "CONTEXT.md",
    "CLASSIFICATION.md",
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
  assert.match(
    firstRun.stdout,
    /Cross-agent follow-up checks will use session_status \+ queued subagent announces, with explicit cross-agent session visibility for supervised recovery\./
  );
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
    "OPENCLAW_HOME",
    "OPENCLAW_CHAT_TRANSPORT",
    "OPENCLAW_REQUEST_ID_MAX_ENTRIES",
    "OPENCLAW_REQUEST_ATTRIBUTION_LOOKBACK_SECONDS",
    "OPENCLAW_REQUEST_ATTRIBUTION_MAX_CANDIDATES",
    "CLAWBOARD_WORKSPACE_IDE_PROVIDER",
    "CLAWBOARD_WORKSPACE_IDE_PORT",
    "CLAWBOARD_WORKSPACE_IDE_CODING_PORT",
    "CLAWBOARD_WORKSPACE_IDE_BASE_URL",
    "CLAWBOARD_WORKSPACE_IDE_BASE_URL_CODING",
    "CLAWBOARD_WORKSPACE_IDE_INTERNAL_BASE_URL_CODING",
    "CLAWBOARD_WORKSPACE_IDE_FOLDER_CODING",
    "CLAWBOARD_WORKSPACE_IDE_PASSWORD",
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
  assert.match(envText, new RegExp(`^OPENCLAW_HOME=${escapeRegex(openclawHome)}$`, "m"));
  assert.match(envText, /^OPENCLAW_CHAT_TRANSPORT=auto$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_PROVIDER=code-server$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_PORT=13337$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_CODING_PORT=13338$/m);
  const publicWebUrl = envLines.find((line) => line.startsWith("CLAWBOARD_PUBLIC_WEB_URL="))?.split("=")[1] ?? "";
  const publicWebHost = new URL(publicWebUrl).hostname;
  assert.match(
    envText,
    new RegExp(`^CLAWBOARD_WORKSPACE_IDE_BASE_URL=http://${escapeRegex(publicWebHost)}:13337$`, "m")
  );
  assert.match(
    envText,
    new RegExp(`^CLAWBOARD_WORKSPACE_IDE_BASE_URL_CODING=http://${escapeRegex(publicWebHost)}:13338$`, "m")
  );
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_INTERNAL_BASE_URL_CODING=http:\/\/workspace-ide-coding:8080$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_FOLDER_CODING=\/workspace$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_PASSWORD=test-token$/m);

  const codeServerSettingsPath = path.join(installDir, "data", "code-server", "local", "User", "settings.json");
  const codeServerSettings = JSON.parse(await readFile(codeServerSettingsPath, "utf8"));
  const codingCodeServerSettingsPath = path.join(installDir, "data", "code-server-coding", "local", "User", "settings.json");
  const codingCodeServerSettings = JSON.parse(await readFile(codingCodeServerSettingsPath, "utf8"));
  assert.equal(codeServerSettings["chat.agent.enabled"], false);
  assert.equal(codeServerSettings["chat.agentsControl.enabled"], false);
  assert.equal(codeServerSettings["chat.disableAIFeatures"], true);
  assert.equal(codeServerSettings["chat.viewSessions.enabled"], false);
  assert.equal(codeServerSettings["files.autoSave"], "off");
  assert.equal(codeServerSettings["git.autofetch"], false);
  assert.equal(codeServerSettings["scm.defaultViewMode"], "tree");
  assert.equal(codeServerSettings["workbench.startupEditor"], "none");
  assert.equal(codeServerSettings["workbench.welcomePage.walkthroughs.openOnInstall"], false);
  assert.equal(codeServerSettings["workbench.colorTheme"], "Default Dark Modern");
  assert.equal(codeServerSettings["workbench.preferredDarkColorTheme"], "Default Dark Modern");
  assert.equal(codeServerSettings["window.autoDetectColorScheme"], false);
  assert.equal(codeServerSettings["security.workspace.trust.enabled"], false);
  assert.deepEqual(codingCodeServerSettings, codeServerSettings);
});

test("bootstrap_clawboard.sh: prefers Tailscale MagicDNS host for public access URLs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-magicdns-"));
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
  await makeTailscaleStub(binDir, {
    dnsName: "magicbox.tail77f45e.ts.net.",
    certDomain: "magicbox.tail77f45e.ts.net",
    ip: "100.88.77.66",
  });
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
      "--skip-plugin",
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

  const envText = await readFile(path.join(installDir, ".env"), "utf8");
  assert.match(envText, /^CLAWBOARD_PUBLIC_WEB_URL=http:\/\/magicbox\.tail77f45e\.ts\.net:3010$/m);
  assert.match(envText, /^CLAWBOARD_PUBLIC_API_BASE=http:\/\/magicbox\.tail77f45e\.ts\.net:8010$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_BASE_URL=http:\/\/magicbox\.tail77f45e\.ts\.net:13337$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_BASE_URL_CODING=http:\/\/magicbox\.tail77f45e\.ts\.net:13338$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_INTERNAL_BASE_URL_CODING=http:\/\/workspace-ide-coding:8080$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_FOLDER_CODING=\/workspace$/m);
  assert.match(envText, /^CLAWBOARD_ALLOWED_DEV_ORIGINS=magicbox\.tail77f45e\.ts\.net$/m);
  assert.doesNotMatch(envText, /^CLAWBOARD_PUBLIC_WEB_URL=http:\/\/100\.88\.77\.66:3010$/m);
  assert.match(
    res.stdout,
    /Tailscale HTTPS is available via https:\/\/magicbox\.tail77f45e\.ts\.net\. Re-run with --setup-tailscale-https to use secure browser URLs\./
  );
});

test("bootstrap_clawboard.sh: configures secure Tailscale HTTPS URLs when opted in", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-tailscale-https-"));
  const repoRoot = path.join(tmp, "repo");
  const installDir = path.join(tmp, "install");
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "openclaw-home");
  const binDir = path.join(tmp, "bin");
  const tailscaleLogPath = path.join(tmp, "tailscale.log");

  await mkdir(repoRoot, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(openclawHome, "workspace"), { recursive: true });
  await seedBootstrapInstallTree(installDir, { includePlugin: false });

  await makeOpenClawStub(binDir);
  await makeTailscaleStub(binDir, {
    dnsName: "magicbox.tail77f45e.ts.net.",
    certDomain: "magicbox.tail77f45e.ts.net",
    ip: "100.88.77.66",
  });
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
    CLAWBOARD_TAILSCALE_HTTPS_SETUP: "always",
    TAILSCALE_STUB_LOG_FILE: tailscaleLogPath,
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
    {
      cwd: repoRoot,
      env,
    }
  );
  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const envText = await readFile(path.join(installDir, ".env"), "utf8");
  assert.match(envText, /^CLAWBOARD_PUBLIC_WEB_URL=https:\/\/magicbox\.tail77f45e\.ts\.net$/m);
  assert.match(envText, /^CLAWBOARD_PUBLIC_API_BASE=https:\/\/magicbox\.tail77f45e\.ts\.net:8443$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_BASE_URL=https:\/\/magicbox\.tail77f45e\.ts\.net:10000$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_BASE_URL_CODING=https:\/\/magicbox\.tail77f45e\.ts\.net:10001$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_INTERNAL_BASE_URL_CODING=http:\/\/workspace-ide-coding:8080$/m);
  assert.match(envText, /^CLAWBOARD_WORKSPACE_IDE_FOLDER_CODING=\/workspace$/m);
  assert.match(envText, /^CLAWBOARD_ALLOWED_DEV_ORIGINS=magicbox\.tail77f45e\.ts\.net$/m);

  const tailscaleLog = await readFile(tailscaleLogPath, "utf8");
  assert.match(tailscaleLog, /^serve --bg --https=443 http:\/\/127\.0\.0\.1:3010$/m);
  assert.match(tailscaleLog, /^serve --bg --https=8443 http:\/\/127\.0\.0\.1:8010$/m);
  assert.match(tailscaleLog, /^serve --bg --https=10000 http:\/\/127\.0\.0\.1:13337$/m);
  assert.match(tailscaleLog, /^serve --bg --https=10001 http:\/\/127\.0\.0\.1:13338$/m);
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
    OPENCLAW_STUB_FAIL_ANY_COMMAND_MISSING_BASEURL: "1",
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

test("bootstrap_clawboard.sh: skip-local-memory-setup avoids model/bootstrap memory setup", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-skip-local-memory-"));
  const repoRoot = path.join(tmp, "repo");
  const installDir = path.join(tmp, "install");
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "openclaw-home");
  const binDir = path.join(tmp, "bin");
  const openclawLogPath = path.join(tmp, "openclaw.log");
  const localMemoryLogPath = path.join(tmp, "local-memory.log");

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
printf '%s\\n' "local-memory-ran" >> "\${LOCAL_MEMORY_SETUP_LOG_FILE}"
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
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CLAWBOARD_TOKEN: "skip-local-memory-token",
  };

  const res = await run(
    [
      "bash",
      path.join(bootstrapPath, "bootstrap_clawboard.sh"),
      "--dir",
      installDir,
      "--skip-docker",
      "--skip-plugin",
      "--skip-local-memory-setup",
      "--skip-memory-backup-setup",
      "--skip-obsidian-memory-setup",
      "--no-access-url-prompt",
      "--no-color",
      "--integration-level",
      "write",
    ],
    { cwd: repoRoot, env }
  );

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /Skipping local memory setup by configuration\./);
  assert.match(res.stdout, /Skipping bootstrap memory index refresh because local memory setup was skipped\./);

  let localMemoryLog = "";
  try {
    localMemoryLog = await readFile(localMemoryLogPath, "utf8");
  } catch (error) {
    assert.equal(error && typeof error === "object" && "code" in error ? error.code : "", "ENOENT");
  }
  assert.equal(localMemoryLog, "");

  let openclawLog = "";
  try {
    openclawLog = await readFile(openclawLogPath, "utf8");
  } catch (error) {
    assert.equal(error && typeof error === "object" && "code" in error ? error.code : "", "ENOENT");
  }
  assert.doesNotMatch(openclawLog, /memory index --agent/);
});

test("bootstrap_clawboard.sh: setup-agentic-team enrolls specialists and syncs main allowAgents without local-memory setup", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-agentic-team-"));
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
  await seedBootstrapInstallTree(installDir, { includePlugin: false, includeSpecialists: true });

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
    OPENCLAW_STUB_LOG_FILE: openclawLogPath,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CLAWBOARD_TOKEN: "agentic-team-token",
  };

  const res = await run(
    [
      "bash",
      path.join(bootstrapPath, "bootstrap_clawboard.sh"),
      "--dir",
      installDir,
      "--skip-docker",
      "--skip-plugin",
      "--skip-local-memory-setup",
      "--skip-memory-backup-setup",
      "--skip-obsidian-memory-setup",
      "--skip-openclaw-heap-setup",
      "--skip-agent-directives",
      "--setup-agentic-team",
      "--no-access-url-prompt",
      "--no-color",
      "--integration-level",
      "write",
    ],
    { cwd: repoRoot, env }
  );

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /Added 4 specialist agent\(s\) to config/);
  assert.match(res.stdout, /Synced main subagents\.allowAgents to configured specialists \(coding, docs, web, social\)\./);
  assert.match(res.stdout, /Agentic team:\s+configured \(coding, docs, web, social\)/);

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const agentIds = config.agents.list.map((entry) => entry.id);
  assert.deepEqual(agentIds, ["main", "coding", "docs", "web", "social"]);
  assert.deepEqual(config.agents.list[0].subagents.allowAgents, ["coding", "docs", "web", "social"]);

  for (const agentId of ["coding", "docs", "web", "social"]) {
    const workspacePath = path.join(openclawHome, `workspace-${agentId}`);
    const agentsText = await readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
    const soulText = await readFile(path.join(workspacePath, "SOUL.md"), "utf8");
    assert.equal(agentsText, `# ${agentId} AGENTS\n`);
    assert.equal(soulText, `# ${agentId} SOUL\n`);
  }

  const openclawLog = await readFile(openclawLogPath, "utf8");
  assert.match(openclawLog, /agents add coding --workspace/);
  assert.match(openclawLog, /agents add docs --workspace/);
  assert.match(openclawLog, /agents add web --workspace/);
  assert.match(openclawLog, /agents add social --workspace/);
});

test("bootstrap_clawboard.sh: writes cross-agent session visibility config", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-session-visibility-"));
  const repoRoot = path.join(tmp, "repo");
  const installDir = path.join(tmp, "install");
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "openclaw-home");
  const binDir = path.join(tmp, "bin");
  const configPath = path.join(openclawHome, "openclaw.json");

  await mkdir(repoRoot, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(openclawHome, "workspace"), { recursive: true });
  await seedBootstrapInstallTree(installDir, { includePlugin: false });

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        gateway: { auth: { token: "bootstrap-session-visibility-token" } },
        agents: {
          defaults: { workspace: path.join(openclawHome, "workspace") },
          list: [{ id: "main", default: true, workspace: path.join(openclawHome, "workspace") }],
        },
      },
      null,
      2
    )}\n`
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
    OPENCLAW_CONFIG_PATH: configPath,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CLAWBOARD_TOKEN: "session-visibility-token",
  };

  const res = await run(
    [
      "bash",
      path.join(bootstrapPath, "bootstrap_clawboard.sh"),
      "--dir",
      installDir,
      "--skip-docker",
      "--skip-plugin",
      "--skip-local-memory-setup",
      "--skip-memory-backup-setup",
      "--skip-obsidian-memory-setup",
      "--skip-openclaw-heap-setup",
      "--skip-agent-directives",
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
    /Cross-agent follow-up checks will use session_status \+ queued subagent announces, with explicit cross-agent session visibility for supervised recovery\./
  );

  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.tools?.sessions?.visibility, "all");
  assert.equal(config.agents?.defaults?.sandbox?.sessionToolsVisibility, "all");
  assert.equal(config.tools?.agentToAgent?.enabled, true);
});

test("bootstrap_clawboard.sh: reconciles macOS LaunchAgent gateway token drift from OpenClaw config", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-bootstrap-launchagent-"));
  const repoRoot = path.join(tmp, "repo");
  const installDir = path.join(tmp, "install");
  const homeDir = path.join(tmp, "home");
  const openclawHome = path.join(tmp, "openclaw-home");
  const binDir = path.join(tmp, "bin");
  const configPath = path.join(openclawHome, "openclaw.json");
  const launchctlLogPath = path.join(tmp, "launchctl.log");
  const launchAgentDir = path.join(homeDir, "Library", "LaunchAgents");
  const launchAgentPath = path.join(launchAgentDir, "ai.openclaw.gateway.plist");
  const expectedToken = "fresh-openclaw-gateway-token";

  await mkdir(repoRoot, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(openclawHome, "workspace"), { recursive: true });
  await mkdir(launchAgentDir, { recursive: true });
  await seedBootstrapInstallTree(installDir, { includePlugin: false });

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        gateway: { auth: { token: expectedToken } },
        agents: {
          defaults: { workspace: path.join(openclawHome, "workspace") },
          list: [{ id: "main", default: true, workspace: path.join(openclawHome, "workspace") }],
        },
      },
      null,
      2
    )}\n`
  );

  await writeFile(
    launchAgentPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.gateway</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCLAW_GATEWAY_TOKEN</key>
    <string>__OPENCLAW_REDACTED__</string>
  </dict>
</dict>
</plist>
`
  );

  await makeOpenClawStub(binDir);
  await makeStub(binDir, "curl", "exit 0");
  await makeStub(binDir, "uname", 'printf "Darwin\\n"');
  await makeStub(
    binDir,
    "launchctl",
    `
log_file="\${LAUNCHCTL_STUB_LOG_FILE:-}"
if [[ -n "$log_file" ]]; then
  printf '%s\\n' "$*" >> "$log_file"
fi
exit 0
`
  );

  const bootstrapPath = path.join(repoRoot, "scripts");
  await mkdir(bootstrapPath, { recursive: true });
  await cp(path.join(process.cwd(), "scripts", "bootstrap_clawboard.sh"), path.join(bootstrapPath, "bootstrap_clawboard.sh"));
  await cp(path.join(process.cwd(), "scripts", "bootstrap_openclaw.sh"), path.join(bootstrapPath, "bootstrap_openclaw.sh"));

  const env = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STUB_REDACT_GATEWAY_TOKEN: "1",
    LAUNCHCTL_STUB_LOG_FILE: launchctlLogPath,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CLAWBOARD_TOKEN: "launchagent-token",
  };

  const res = await run(
    [
      "bash",
      path.join(bootstrapPath, "bootstrap_clawboard.sh"),
      "--dir",
      installDir,
      "--skip-docker",
      "--skip-plugin",
      "--skip-local-memory-setup",
      "--skip-memory-backup-setup",
      "--skip-obsidian-memory-setup",
      "--skip-openclaw-heap-setup",
      "--skip-agent-directives",
      "--no-access-url-prompt",
      "--no-color",
      "--integration-level",
      "write",
    ],
    { cwd: repoRoot, env }
  );

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /Updated macOS OpenClaw gateway LaunchAgent token to match current config\./);
  assert.match(res.stdout, /Reloaded macOS OpenClaw gateway LaunchAgent after token reconciliation\./);

  const launchAgentText = await readFile(launchAgentPath, "utf8");
  assert.match(launchAgentText, new RegExp(expectedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(launchAgentText, /__OPENCLAW_REDACTED__/);

  const launchctlLog = await readFile(launchctlLogPath, "utf8");
  assert.match(launchctlLog, /bootout/);
  assert.match(launchctlLog, /bootstrap/);
  assert.match(launchctlLog, /kickstart/);
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
  assert.match(setupText, /do not send another status-only update/i);
  assert.match(setupText, /session_status/i);
  assert.match(setupText, /queued sub-agent completion|queued sub-agent result/i);
  assert.match(setupText, /do not restate or paraphrase the full body|do not parrot it back/i);
  assert.match(setupText, /current (topic|task) thread/i);
  assert.match(setupText, /"sessions_spawn","sessions_list","sessions_send","session_status"/i);
  assert.match(setupText, /"memory_search","memory_get","cron","image","clawboard_search"/i);
  assert.match(setupText, /"clawboard_update_topic","clawboard_get_topic"/i);
  assert.doesNotMatch(setupText, /"sessions_history"/i);
  assert.doesNotMatch(setupText, /"group:nodes","group:messaging","image"/i);
  assert.match(setupText, /Delegation tools: sessions_spawn, session_status, sessions_list, sessions_send, cron/i);
  assert.match(setupText, /memoryFlush\.enabled true json false/i);
  assert.match(setupText, /memory\.backend=qmd.*memory-only source/i);
  assert.match(setupText, /memory\.qmd\.sessions\.enabled false json true/i);
  assert.match(agentsText, />5m|5 minutes/i);
  assert.match(heartbeatText, />5m|5 minutes/i);
  assert.match(agentsText, /do not send repetitive status-only messages|do not keep posting/i);
  assert.match(heartbeatText, /do not send another status-only update|nothing materially changed/i);
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

test("specialist contracts document dynamic clawboard repo resolution", async () => {
  const root = process.cwd();
  const codingAgentPath = path.join(root, "agent-templates", "coding", "AGENTS.md");
  const docsAgentPath = path.join(root, "agent-templates", "docs", "AGENTS.md");
  const codingDirectivePath = path.join(root, "directives", "coding", "CODING_CONTRACT.md");
  const docsDirectivePath = path.join(root, "directives", "docs", "DOCS_CONTRACT.md");
  const mainAgentPath = path.join(root, "agent-templates", "main", "AGENTS.md");

  const [codingAgentText, docsAgentText, codingDirectiveText, docsDirectiveText, mainAgentText] =
    await Promise.all([
      readFile(codingAgentPath, "utf8"),
      readFile(docsAgentPath, "utf8"),
      readFile(codingDirectivePath, "utf8"),
      readFile(docsDirectivePath, "utf8"),
      readFile(mainAgentPath, "utf8"),
    ]);

  for (const text of [codingAgentText, docsAgentText, codingDirectiveText, docsDirectiveText]) {
    assert.match(text, /configured OpenClaw workspaces|installation config/i);
    assert.match(text, /explicit path from the (task|delegated task)|current working tree/i);
    assert.match(text, /projects\/clawboard/i);
    assert.match(text, /Do not assume .*OPENCLAW_HOME.* set|Do not assume .*OPENCLAW_HOME.* exported/i);
  }
  for (const text of [codingAgentText, codingDirectiveText]) {
    assert.match(text, /skills\/clawboard/i);
  }
  for (const text of [docsAgentText, docsDirectiveText]) {
    assert.match(text, /OpenClaw docs|OpenClaw docs trees/i);
  }
  assert.match(mainAgentText, /canonical repo root|exact file path/i);
});

test("main-agent orchestration contract documents runtime model, specialist map, and decision escalation", async () => {
  const root = process.cwd();
  const agentsPath = path.join(root, "agent-templates", "main", "AGENTS.md");
  const soulPath = path.join(root, "agent-templates", "main", "SOUL.md");
  const heartbeatPath = path.join(root, "agent-templates", "main", "HEARTBEAT.md");
  const bootstrapPath = path.join(root, "agent-templates", "main", "BOOTSTRAP.md");
  const directivePath = path.join(root, "directives", "main", "GENERAL_CONTRACTOR.md");
  const setupPath = path.join(root, "skills", "clawboard", "scripts", "setup-openclaw-local-memory.sh");
  const readmePath = path.join(root, "README.md");

  const [agentsText, soulText, heartbeatText, bootstrapText, directiveText, setupText, readmeText] = await Promise.all([
    readFile(agentsPath, "utf8"),
    readFile(soulPath, "utf8"),
    readFile(heartbeatPath, "utf8"),
    readFile(bootstrapPath, "utf8"),
    readFile(directivePath, "utf8"),
    readFile(setupPath, "utf8"),
    readFile(readmePath, "utf8"),
  ]);

  assert.match(agentsText, /OpenClaw.*runtime/i);
  assert.match(agentsText, /Clawboard.*durable ledger/i);
  assert.match(agentsText, /coding.*docs.*web.*social/is);
  assert.match(agentsText, /user decision|missing constraints|blocked/i);
  assert.match(agentsText, /session_status/i);
  assert.match(agentsText, /queued auto-announces|queued completion/i);
  assert.match(agentsText, /do not restate or paraphrase the full body/i);
  assert.match(agentsText, /sibling specialists.*still active|partial results internal/i);
  assert.match(agentsText, /checking the other specialists|awaiting the rest|no new user-facing text/i);
  assert.match(agentsText, /current-(topic|task) thread|current (topic|task) thread/i);
  assert.match(agentsText, /skip the (ledger|task) write instead of guessing from the title/i);
  assert.match(agentsText, /Do not call `session_status` in the same turn you just spawned/i);
  assert.match(agentsText, /very next action.*plain-text user update/i);

  assert.match(soulText, /OpenClaw.*sessions.*cron/i);
  assert.match(soulText, /Clawboard.*durable external ledger/i);
  assert.match(soulText, /coding.*docs.*web.*social/is);
  assert.match(soulText, /blocker requires a user decision/i);
  assert.match(soulText, /do not parrot|do not repeat the full body/i);
  assert.match(soulText, /do not burn an extra turn polling `session_status` immediately after `sessions_spawn`/i);
  assert.match(soulText, /first action after `sessions_spawn\(\.\.\.\)` must be that short user-facing dispatch update/i);

  assert.match(heartbeatText, /user decision/i);
  assert.match(heartbeatText, /session_status/i);
  assert.match(heartbeatText, /queued subagent completion|queued completion/i);
  assert.match(heartbeatText, /do not restate the full body|do not parrot it back/i);
  assert.match(heartbeatText, /sibling specialists.*still active|partial results internal/i);
  assert.match(heartbeatText, /checking or waiting on the other specialists|preferred next action is no user-facing text/i);
  assert.match(heartbeatText, /before any extra tool call or (task|ledger) write/i);
  assert.match(bootstrapText, /blocked on a real user decision/i);
  assert.match(bootstrapText, /session_status/i);
  assert.match(bootstrapText, /skip `clawboard_update_(topic|task)\(\)` instead of guessing from a (topic|task) title/i);
  assert.match(bootstrapText, /Do not call `session_status\(childSessionKey\)` in that same post-spawn turn/i);
  assert.match(bootstrapText, /next action must be a plain-text dispatch update to the user immediately/i);
  assert.match(bootstrapText, /do not restate or paraphrase the full body/i);
  assert.match(bootstrapText, /sibling specialists.*still active|partial results internal/i);
  assert.match(bootstrapText, /checking the others|awaiting the rest/i);
  assert.match(bootstrapText, /before any extra tool call or (task|ledger) write/i);
  assert.match(directiveText, /OpenClaw is the runtime/i);
  assert.match(directiveText, /Clawboard is the durable ledger/i);
  assert.match(directiveText, /user decision/i);
  assert.match(directiveText, /do not parrot the full body back/i);
  assert.match(directiveText, /sibling specialists.*still active|partial completions internal/i);
  assert.match(directiveText, /checking the others|awaiting the rest|no new visible text/i);
  assert.match(setupText, /current (topic|task) thread/i);
  assert.match(setupText, /do not restate or paraphrase the full body|do not parrot it back/i);
  assert.match(setupText, /sibling specialists.*still active|partial results internal/i);
  assert.match(setupText, /checking or waiting on the remaining specialists|checking or waiting on the rest/i);
  assert.match(readmeText, /setup-agentic-team/i);
  assert.match(readmeText, /CLAWBOARD_AGENTIC_TEAM_SETUP=always/i);
});

test("bootstrap_clawboard.sh: interactive agentic team and backup setup both prompt through /dev/tty", async () => {
  const root = process.cwd();
  const bootstrapPath = path.join(root, "scripts", "bootstrap_clawboard.sh");
  const bootstrapText = await readFile(bootstrapPath, "utf8");

  const agenticSetupBlock = bootstrapText.match(/maybe_offer_agentic_team_setup\(\) \{[\s\S]*?\n\}/);
  const backupSetupBlock = bootstrapText.match(/maybe_offer_memory_backup_setup\(\) \{[\s\S]*?\n\}/);

  assert.ok(agenticSetupBlock, "expected maybe_offer_agentic_team_setup() block");
  assert.ok(backupSetupBlock, "expected maybe_offer_memory_backup_setup() block");

  assert.match(agenticSetupBlock[0], /prompt_yes_no_tty/);
  assert.match(backupSetupBlock[0], /prompt_yes_no_tty/);
  assert.doesNotMatch(backupSetupBlock[0], /\[\s*!\s*-t 0\s*\]/);
  assert.match(bootstrapText, /CLAWBOARD_AGENTIC_TEAM_SETUP=<ask\|always\|never>/);
  assert.match(bootstrapText, /CLAWBOARD_MEMORY_BACKUP_SETUP=<ask\|always\|never>/);
});
