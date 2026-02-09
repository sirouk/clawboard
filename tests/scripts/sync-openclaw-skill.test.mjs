import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, readdir } from "node:fs/promises";
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
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
}

test("sync_openclaw_skill.sh: dry-run prints diff summary and rsync command", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-skill-sync-"));
  const repoRoot = path.join(tmp, "repo");
  const openclawHome = path.join(tmp, "openclaw");
  const scriptDir = path.join(repoRoot, "scripts");
  await mkdir(scriptDir, { recursive: true });

  const scriptPath = path.join(scriptDir, "sync_openclaw_skill.sh");
  await cp(path.join(process.cwd(), "scripts", "sync_openclaw_skill.sh"), scriptPath);

  const src = path.join(openclawHome, "skills", "clawboard");
  const dst = path.join(repoRoot, "skills", "clawboard");
  await mkdir(src, { recursive: true });
  await mkdir(dst, { recursive: true });

  await writeFile(path.join(src, "SKILL.md"), "source\n");
  await writeFile(path.join(dst, "SKILL.md"), "dest\n");

  const res = await run(["bash", scriptPath, "--src", src, "--dst", dst], {
    cwd: repoRoot,
    env: { ...process.env, OPENCLAW_HOME: openclawHome },
  });

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /Mode:\s+DRY_RUN/);
  assert.match(res.stdout, /Diff summary/);
  assert.match(res.stdout, /DRY_RUN: would run:/);
  assert.match(res.stdout, /rsync -a --delete/);
});

test("sync_openclaw_skill.sh: apply mirrors src into dst (including deletions)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "clawboard-skill-sync-apply-"));
  const repoRoot = path.join(tmp, "repo");
  const openclawHome = path.join(tmp, "openclaw");
  const scriptDir = path.join(repoRoot, "scripts");
  await mkdir(scriptDir, { recursive: true });

  const scriptPath = path.join(scriptDir, "sync_openclaw_skill.sh");
  await cp(path.join(process.cwd(), "scripts", "sync_openclaw_skill.sh"), scriptPath);

  const src = path.join(openclawHome, "skills", "clawboard");
  const dst = path.join(repoRoot, "skills", "clawboard");
  await mkdir(src, { recursive: true });
  await mkdir(dst, { recursive: true });

  await writeFile(path.join(src, "SKILL.md"), "source\n");
  await writeFile(path.join(src, "extra.txt"), "extra\n");
  await writeFile(path.join(dst, "SKILL.md"), "old\n");
  await writeFile(path.join(dst, "remove-me.txt"), "remove\n");

  const res = await run(["bash", scriptPath, "--apply", "--force", "--src", src, "--dst", dst], {
    cwd: repoRoot,
    env: { ...process.env, OPENCLAW_HOME: openclawHome },
  });

  assert.equal(res.code, 0, `exit=${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /OK: synced skill into repo/);

  const files = await listFiles(dst);
  assert.deepEqual(files, ["SKILL.md", "extra.txt"]);
  const skillText = await readFile(path.join(dst, "SKILL.md"), "utf8");
  assert.equal(skillText, "source\n");
});

