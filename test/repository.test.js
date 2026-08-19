import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { lockRepository } from "../src/repository.js";

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

test("local scans disable executable Git configuration and exclude ignored files", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "repo2skill-local-git-safety-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const repository = path.join(sandbox, "repository");
  const marker = path.join(sandbox, "git-code-executed");
  const executable = path.join(sandbox, "record-execution.sh");
  const hooks = path.join(sandbox, "hooks");
  const globalExcludes = path.join(sandbox, "global-excludes");

  runGit(["init", "--quiet", "--initial-branch=main", repository], sandbox);
  runGit(["-C", repository, "config", "user.email", "fixture@example.invalid"], sandbox);
  runGit(["-C", repository, "config", "user.name", "Repo2Skill Local Safety Fixture"], sandbox);
  await writeFile(path.join(repository, ".gitignore"), "ignored.env\n", "utf8");
  await writeFile(path.join(repository, ".gitattributes"), "*.txt filter=evil\n", "utf8");
  await writeFile(path.join(repository, "README.md"), "# Local safety fixture\n", "utf8");
  await writeFile(path.join(repository, "tracked.txt"), "tracked\n", "utf8");
  runGit(["-C", repository, "add", "."], sandbox);
  runGit(["-C", repository, "commit", "--quiet", "-m", "initial"], sandbox);

  await mkdir(hooks);
  await writeFile(executable, `#!/bin/sh\nprintf invoked >> '${marker}'\nexit 0\n`, "utf8");
  await chmod(executable, 0o755);
  await writeFile(path.join(hooks, "post-checkout"), await readFile(executable), "utf8");
  await chmod(path.join(hooks, "post-checkout"), 0o755);
  await writeFile(globalExcludes, "visible.txt\n", "utf8");
  await writeFile(path.join(repository, ".git", "info", "exclude"), "info-ignored.env\n", "utf8");
  await writeFile(path.join(repository, "ignored.env"), "IGNORED_SECRET=one\n", "utf8");
  await writeFile(path.join(repository, "info-ignored.env"), "IGNORED_SECRET=two\n", "utf8");
  await writeFile(path.join(repository, "visible.txt"), "visible despite configured global excludes\n", "utf8");

  runGit(["-C", repository, "config", "core.hooksPath", hooks], sandbox);
  runGit(["-C", repository, "config", "core.fsmonitor", executable], sandbox);
  runGit(["-C", repository, "config", "core.attributesFile", path.join(sandbox, "attributes")], sandbox);
  runGit(["-C", repository, "config", "core.excludesFile", globalExcludes], sandbox);
  const index = path.join(repository, ".git", "index");
  const beforeIndex = await stat(index, { bigint: true });
  const lock = await lockRepository(repository);
  const afterIndex = await stat(index, { bigint: true });
  const paths = lock.files.map((file) => file.path);

  assert.ok(paths.includes("tracked.txt"));
  assert.ok(paths.includes("visible.txt"), "user/repository core.excludesFile must not silently shrink scan scope");
  assert.equal(paths.includes("ignored.env"), false);
  assert.equal(paths.includes("info-ignored.env"), false);
  assert.equal(lock.files.some((file) => file.text.includes("IGNORED_SECRET")), false);
  assert.equal(afterIndex.mtimeNs, beforeIndex.mtimeNs, "read-only Git calls must not refresh the index");
  await assert.rejects(readFile(marker), (error) => error.code === "ENOENT");

  runGit(["-C", repository, "config", "filter.evil.clean", executable], sandbox);
  runGit(["-C", repository, "config", "filter.evil.smudge", executable], sandbox);
  runGit(["-C", repository, "config", "filter.evil.process", executable], sandbox);
  runGit(["-C", repository, "config", "filter.evil.required", "true"], sandbox);
  await writeFile(path.join(repository, "tracked.txt"), "changed\n", "utf8");
  await assert.rejects(lockRepository(repository), /executable or included local Git configuration/);
  await assert.rejects(readFile(marker), (error) => error.code === "ENOENT");
});
