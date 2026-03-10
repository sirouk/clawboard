import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

async function git(args, { cwd, env } = {}) {
  const res = await run(["git", ...args], { cwd, env });
  assert.equal(res.code, 0, `git ${args.join(" ")} failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return res;
}

test("backup_openclaw_curated_memories clones an existing remote before first backup", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-memory-backup-"));
  const remoteRepo = path.join(tmp, "remote.git");
  const seedRepo = path.join(tmp, "seed");
  const workspacePath = path.join(tmp, "workspace");
  const openclawDir = path.join(tmp, "openclaw");
  const credentialsDir = path.join(openclawDir, "credentials");
  const backupDir = path.join(tmp, "memory-backup-repo");
  const credentialsJson = path.join(credentialsDir, "clawboard-memory-backup.json");
  const credentialsEnv = path.join(credentialsDir, "clawboard-memory-backup.env");
  const scriptPath = path.join(process.cwd(), "skills", "clawboard", "scripts", "backup_openclaw_curated_memories.sh");

  await mkdir(workspacePath, { recursive: true });
  await mkdir(credentialsDir, { recursive: true });

  await git(["init", "--bare", "--initial-branch=main", remoteRepo], { cwd: tmp });
  await git(["clone", remoteRepo, seedRepo], { cwd: tmp });
  await git(["-C", seedRepo, "config", "user.name", "Seed Bot"], { cwd: tmp });
  await git(["-C", seedRepo, "config", "user.email", "seed@example.com"], { cwd: tmp });
  await writeFile(path.join(seedRepo, "README.md"), "seed backup repo\n");
  await git(["-C", seedRepo, "add", "README.md"], { cwd: tmp });
  await git(["-C", seedRepo, "commit", "-m", "Seed remote"], { cwd: tmp });
  await git(["-C", seedRepo, "push", "origin", "main"], { cwd: tmp });

  await writeFile(path.join(workspacePath, "AGENTS.md"), "# Main\n");
  await writeFile(
    credentialsJson,
    JSON.stringify(
      {
        workspacePath,
        workspacePaths: [],
        qmdPaths: [],
        backupDir,
        repoUrl: remoteRepo,
        repoSshUrl: "",
        authMethod: "pat",
        deployKeyPath: "",
        githubUser: "backup-bot",
        githubPat: "test-token",
        remoteName: "origin",
        branch: "main",
        includeOpenclawConfig: false,
        includeOpenclawSkills: false,
        includeClawboardState: false,
        clawboardDir: "",
        clawboardApiUrl: "",
        includeClawboardAttachments: false,
        includeClawboardEnv: false,
      },
      null,
      2
    )
  );
  await writeFile(credentialsEnv, "");

  const env = {
    ...process.env,
    HOME: tmp,
    OPENCLAW_DIR: openclawDir,
  };

  const res = await run(["bash", scriptPath, "--credentials-json", credentialsJson, "--credentials-env", credentialsEnv], {
    cwd: tmp,
    env,
  });
  assert.equal(res.code, 0, `backup script failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const count = await git(["-C", backupDir, "rev-list", "--count", "HEAD"], { cwd: tmp, env });
  assert.equal(count.stdout.trim(), "2");

  const tree = await git(["-C", backupDir, "ls-tree", "--name-only", "HEAD"], { cwd: tmp, env });
  assert.match(tree.stdout, /AGENTS\.md/);

  const parentTree = await git(["-C", backupDir, "ls-tree", "--name-only", "HEAD~1"], { cwd: tmp, env });
  assert.match(parentTree.stdout, /README\.md/);

  const branch = await git(["-C", backupDir, "branch", "-vv"], { cwd: tmp, env });
  assert.match(branch.stdout, /\[origin\/main\]/);
});
