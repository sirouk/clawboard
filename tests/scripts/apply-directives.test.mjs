import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, cp } from "node:fs/promises";
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

function directiveMarkers(text) {
  const out = [];
  const re = /<!--\s*CLAWBOARD_DIRECTIVE:START\s+([^>]+?)\s*-->/g;
  for (const match of text.matchAll(re)) {
    out.push(match[1].trim());
  }
  return out;
}

test("apply_directives_to_agents.sh reconciles scope, replaces blocks, and prunes stale directives", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-apply-directives-"));
  const repoRoot = path.join(tmp, "repo");
  const scriptsDir = path.join(repoRoot, "scripts");
  const directivesDir = path.join(repoRoot, "directives");
  const templatesMainDir = path.join(repoRoot, "agent-templates", "main");
  const setupDir = path.join(repoRoot, "skills", "clawboard", "scripts");
  const ocHome = path.join(tmp, "openclaw");
  const workspaces = {
    main: path.join(ocHome, "workspace"),
    coding: path.join(ocHome, "workspace", "subagents", "coding"),
    web: path.join(ocHome, "workspace", "subagents", "web"),
    docs: path.join(ocHome, "workspace", "subagents", "docs"),
    social: path.join(ocHome, "workspace", "subagents", "social"),
  };

  await mkdir(scriptsDir, { recursive: true });
  await mkdir(directivesDir, { recursive: true });
  await mkdir(templatesMainDir, { recursive: true });
  await mkdir(setupDir, { recursive: true });
  await mkdir(ocHome, { recursive: true });
  await Promise.all(Object.values(workspaces).map((ws) => mkdir(ws, { recursive: true })));

  await cp(path.join(process.cwd(), "scripts", "apply_directives_to_agents.sh"), path.join(scriptsDir, "apply_directives_to_agents.sh"));
  await cp(path.join(process.cwd(), "directives"), directivesDir, { recursive: true });
  await cp(path.join(process.cwd(), "agent-templates", "main", "AGENTS.md"), path.join(templatesMainDir, "AGENTS.md"));
  await cp(path.join(process.cwd(), "agent-templates", "main", "SOUL.md"), path.join(templatesMainDir, "SOUL.md"));
  await cp(path.join(process.cwd(), "agent-templates", "main", "HEARTBEAT.md"), path.join(templatesMainDir, "HEARTBEAT.md"));
  await cp(
    path.join(process.cwd(), "skills", "clawboard", "scripts", "setup-openclaw-local-memory.sh"),
    path.join(setupDir, "setup-openclaw-local-memory.sh")
  );
  await cp(path.join(process.cwd(), "ANATOMY.md"), path.join(repoRoot, "ANATOMY.md"));
  await cp(path.join(process.cwd(), "CONTEXT.md"), path.join(repoRoot, "CONTEXT.md"));
  await cp(path.join(process.cwd(), "CLASSIFICATION.md"), path.join(repoRoot, "CLASSIFICATION.md"));

  const config = {
    agents: {
      list: [
        { id: "main", name: "Main Agent", workspace: workspaces.main, subagents: { allowAgents: ["coding", "web", "docs", "social"] } },
        { id: "coding", name: "Coding", workspace: workspaces.coding },
        { id: "web", name: "Web", workspace: workspaces.web },
        { id: "docs", name: "Docs", workspace: workspaces.docs },
        { id: "social", name: "Social", workspace: workspaces.social },
      ],
    },
  };
  await writeFile(path.join(ocHome, "openclaw.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const staleCodingBlock = `
<!-- CLAWBOARD_DIRECTIVE:START coding/CODING_CONTRACT.md -->
stale coding directive for wrong workspace
<!-- CLAWBOARD_DIRECTIVE:END coding/CODING_CONTRACT.md -->
`;
  const staleMainBlock = `
<!-- CLAWBOARD_DIRECTIVE:START main/GENERAL_CONTRACTOR.md -->
outdated main directive text
<!-- CLAWBOARD_DIRECTIVE:END main/GENERAL_CONTRACTOR.md -->
`;
  const duplicateMainBlock = `
<!-- CLAWBOARD_DIRECTIVE:START main/GENERAL_CONTRACTOR.md -->
duplicate main directive block
<!-- CLAWBOARD_DIRECTIVE:END main/GENERAL_CONTRACTOR.md -->
`;

  await writeFile(path.join(workspaces.main, "AGENTS.md"), `# Main\n${staleMainBlock}\n${duplicateMainBlock}\n`, "utf8");
  await writeFile(path.join(workspaces.coding, "AGENTS.md"), "# Coding\n", "utf8");
  await writeFile(path.join(workspaces.web, "AGENTS.md"), `# Web\n${staleCodingBlock}\n`, "utf8");
  await writeFile(path.join(workspaces.docs, "AGENTS.md"), "# Docs\n", "utf8");
  await writeFile(path.join(workspaces.social, "AGENTS.md"), "# Social\n", "utf8");

  const env = {
    ...process.env,
    OPENCLAW_HOME: ocHome,
    OPENCLAW_CONFIG_PATH: path.join(ocHome, "openclaw.json"),
  };

  const firstRun = await run(["bash", path.join(repoRoot, "scripts", "apply_directives_to_agents.sh"), "--yes", "--no-color"], {
    cwd: repoRoot,
    env,
  });
  assert.equal(firstRun.code, 0, `exit=${firstRun.code}\nstdout:\n${firstRun.stdout}\nstderr:\n${firstRun.stderr}`);

  const mainText = await readFile(path.join(workspaces.main, "AGENTS.md"), "utf8");
  const codingText = await readFile(path.join(workspaces.coding, "AGENTS.md"), "utf8");
  const webText = await readFile(path.join(workspaces.web, "AGENTS.md"), "utf8");
  const docsText = await readFile(path.join(workspaces.docs, "AGENTS.md"), "utf8");
  const socialText = await readFile(path.join(workspaces.social, "AGENTS.md"), "utf8");

  assert.match(mainText, /Loop breaker rule/i);
  assert.equal(mainText.includes("outdated main directive text"), false);
  assert.equal(mainText.includes("duplicate main directive block"), false);
  assert.equal((mainText.match(/CLAWBOARD_DIRECTIVE:START main\/GENERAL_CONTRACTOR\.md/g) || []).length, 1);

  assert.deepEqual(
    new Set(directiveMarkers(mainText)),
    new Set(["all/FIGURE_IT_OUT.md", "main/GENERAL_CONTRACTOR.md"])
  );
  assert.deepEqual(
    new Set(directiveMarkers(codingText)),
    new Set(["all/FIGURE_IT_OUT.md", "coding/CODING_CONTRACT.md"])
  );
  assert.deepEqual(
    new Set(directiveMarkers(webText)),
    new Set(["all/FIGURE_IT_OUT.md", "web/WEB_CONTRACT.md"])
  );
  assert.deepEqual(
    new Set(directiveMarkers(docsText)),
    new Set(["all/FIGURE_IT_OUT.md", "docs/DOCS_CONTRACT.md"])
  );
  assert.deepEqual(
    new Set(directiveMarkers(socialText)),
    new Set(["all/FIGURE_IT_OUT.md", "social/SOCIAL_CONTRACT.md"])
  );
  assert.equal(webText.includes("stale coding directive for wrong workspace"), false);

  const snapshotMain = mainText;
  const snapshotWeb = webText;
  const secondRun = await run(["bash", path.join(repoRoot, "scripts", "apply_directives_to_agents.sh"), "--yes", "--no-color"], {
    cwd: repoRoot,
    env,
  });
  assert.equal(secondRun.code, 0, `exit=${secondRun.code}\nstdout:\n${secondRun.stdout}\nstderr:\n${secondRun.stderr}`);
  assert.equal(await readFile(path.join(workspaces.main, "AGENTS.md"), "utf8"), snapshotMain);
  assert.equal(await readFile(path.join(workspaces.web, "AGENTS.md"), "utf8"), snapshotWeb);
});
