import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { generatePackage, inspectRepository } from "../src/compiler.js";
import { lockRepository } from "../src/repository.js";
import {
  GithubSourceError,
  githubCacheKey,
  normalizePublicGithubUrl,
  resolvePublicGithubSource
} from "../src/source.js";

const PUBLIC_URL = "https://github.com/Acme/Repo2Skill-Fixture";
const CANONICAL_URL = "https://github.com/acme/repo2skill-fixture.git";

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function gitControlPlane(repositoryPath) {
  const entries = [];
  const gitDirectory = path.join(repositoryPath, ".git");
  async function walk(current, relativeDirectory = "") {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const absolute = path.join(current, child.name);
      const stat = await lstat(absolute);
      const entry = {
        path: `.git/${relative}`,
        mode: stat.mode & 0o777,
        kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other"
      };
      if (stat.isFile()) {
        entry.size = stat.size;
        if (!relative.startsWith("objects/")) {
          entry.hash = createHash("sha256").update(await readFile(absolute)).digest("hex");
        }
      }
      entries.push(entry);
      if (stat.isDirectory()) await walk(absolute, relative);
    }
  }
  await walk(gitDirectory);
  return {
    version: 1,
    entryCount: entries.length,
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex")
  };
}

async function localRemote(t) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "repo2skill-source-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const work = path.join(sandbox, "work");
  const bare = path.join(sandbox, "remote.git");
  const cacheRoot = path.join(sandbox, "cache");
  runGit(["init", "--quiet", "--initial-branch=main", work], sandbox);
  runGit(["-C", work, "config", "user.email", "fixture@example.invalid"], sandbox);
  runGit(["-C", work, "config", "user.name", "Repo2Skill Source Fixture"], sandbox);
  await writeFile(path.join(work, "README.md"), "# Offline public-repository fixture\n", "utf8");
  await writeFile(path.join(work, ".gitignore"), "ignored.env\n", "utf8");
  await writeFile(path.join(work, "package.json"), JSON.stringify({
    name: "source-fixture",
    scripts: {
      build: "node -e 'throw new Error(\"must never run\")'",
      format: "node -e 'throw new Error(\"must never run\")'",
      lint: "node -e 'throw new Error(\"must never run\")'",
      test: "node -e 'throw new Error(\"must never run\")'"
    }
  }, null, 2), "utf8");
  await writeFile(path.join(work, ".gitattributes"), "*.bin filter=evil -text\n", "utf8");
  await writeFile(path.join(work, "asset.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 1\n", "utf8");
  runGit(["-C", work, "add", "."], sandbox);
  runGit(["-C", work, "commit", "--quiet", "-m", "initial"], sandbox);
  runGit(["init", "--quiet", "--bare", "--initial-branch=main", bare], sandbox);
  runGit(["-C", work, "remote", "add", "origin", bare], sandbox);
  runGit(["-C", work, "push", "--quiet", "--set-upstream", "origin", "main"], sandbox);
  return { sandbox, work, bare, cacheRoot };
}

function offlineGitRunner(bare, calls, { home } = {}) {
  const localUrl = pathToFileURL(bare).href;
  return ({ args, cwd, env, timeoutMs, maxOutputBytes }) => {
    calls.push({ args: [...args], cwd, env: { ...env }, timeoutMs, maxOutputBytes });
    const mappedArgs = args.map((argument) => {
      if (argument === CANONICAL_URL) return localUrl;
      // Production forbids local transports. This one trusted test runner maps the
      // already-validated public URL to a local bare remote so tests never use the network.
      if (argument === "protocol.file.allow=never") return "protocol.file.allow=always";
      return argument;
    });
    const result = spawnSync("git", mappedArgs, {
      cwd,
      env: home ? { ...env, HOME: home } : env,
      encoding: "utf8",
      shell: false,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      error: result.error
    };
  };
}

async function hostileGlobalGitConfig(sandbox) {
  const home = path.join(sandbox, "hostile-home");
  const hooks = path.join(home, "hooks");
  const marker = path.join(sandbox, "git-code-executed");
  const executable = path.join(home, "record-execution.sh");
  const attributes = path.join(home, "attributes");
  await mkdir(hooks, { recursive: true });
  await writeFile(executable, `#!/bin/sh\nprintf invoked >> '${marker}'\nexit 0\n`, "utf8");
  await chmod(executable, 0o755);
  await writeFile(path.join(hooks, "post-checkout"), await readFile(executable), "utf8");
  await chmod(path.join(hooks, "post-checkout"), 0o755);
  await writeFile(attributes, "*.md filter=evil\n", "utf8");
  await writeFile(path.join(home, ".gitconfig"), [
    "[core]",
    `\thooksPath = ${hooks}`,
    `\tfsmonitor = ${executable}`,
    `\tattributesFile = ${attributes}`,
    "[filter \"evil\"]",
    `\tclean = ${executable}`,
    `\tsmudge = ${executable}`,
    `\tprocess = ${executable}`,
    "\trequired = true",
    "[credential]",
    `\thelper = !${executable}`,
    ""
  ].join("\n"), "utf8");
  return { home, marker };
}

test("public GitHub URLs canonicalize to one credential-free cache identity", () => {
  const plain = normalizePublicGithubUrl(PUBLIC_URL);
  const gitSuffix = normalizePublicGithubUrl("https://GITHUB.com/acme/repo2skill-fixture.git");
  assert.deepEqual(plain, {
    owner: "acme",
    repository: "repo2skill-fixture",
    canonicalUrl: CANONICAL_URL
  });
  assert.deepEqual(gitSuffix, plain);
  assert.equal(githubCacheKey(PUBLIC_URL), githubCacheKey(gitSuffix));
  assert.match(githubCacheKey(PUBLIC_URL), /^[0-9a-f]{64}$/);
});

test("URL validation rejects credentials, alternate transports, ambiguous paths, and non-GitHub hosts", () => {
  const rejected = [
    "http://github.com/acme/repo",
    "https://token@github.com/acme/repo",
    "https://token:secret@github.com/acme/repo.git",
    "https://github.com:443/acme/repo",
    "https://github.com/acme/repo?ref=main",
    "https://github.com/acme/repo#readme",
    "https://github.com/acme/repo/",
    "https://github.com/acme/repo/issues",
    "https://github.com/acme%2frepo/other",
    "https://github.com\\acme\\repo",
    "https://github.example/acme/repo",
    "https://raw.githubusercontent.com/acme/repo",
    "git@github.com:acme/repo.git",
    "ssh://git@github.com/acme/repo.git",
    "git://github.com/acme/repo.git",
    "file:///tmp/repo",
    "/tmp/repo",
    " https://github.com/acme/repo"
  ];
  for (const input of rejected) {
    assert.throws(
      () => normalizePublicGithubUrl(input),
      (error) => error instanceof GithubSourceError && error.code === "INVALID_GITHUB_URL" && !error.message.includes("token:secret")
    );
  }
});

test("isolated clone is cached, detached, and refreshes the remote default branch without executing repository code", async (t) => {
  const remote = await localRemote(t);
  const hostile = await hostileGlobalGitConfig(remote.sandbox);
  const calls = [];
  const gitRunner = offlineGitRunner(remote.bare, calls, { home: hostile.home });
  const firstRevision = runGit(["-C", remote.work, "rev-parse", "HEAD"], remote.sandbox);
  const first = await resolvePublicGithubSource(PUBLIC_URL, {
    cacheRoot: remote.cacheRoot,
    gitRunner,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  });

  assert.equal(first.cacheHit, false);
  assert.equal(first.canonicalUrl, CANONICAL_URL);
  assert.equal(first.revision, firstRevision);
  assert.equal(first.commit, firstRevision);
  assert.equal(first.defaultBranch, "main");
  assert.equal(first.analysisPath, first.repoPath);
  assert.equal(first.readOnly, true);
  assert.equal(runGit(["-C", first.repoPath, "status", "--porcelain=v1", "--untracked-files=all"], remote.sandbox), "");
  assert.equal(runGit(["-C", first.repoPath, "rev-parse", "--abbrev-ref", "HEAD"], remote.sandbox), "HEAD");
  assert.match(await readFile(path.join(first.repoPath, "README.md"), "utf8"), /Offline public-repository/);

  const clone = calls.find((call) => call.args.includes("clone"));
  assert.ok(clone, "a cache miss must clone exactly into the isolated cache");
  assert.ok(clone.args.includes("--depth=1"));
  assert.ok(clone.args.includes("--single-branch"));
  assert.ok(clone.args.includes("--no-tags"));
  assert.ok(clone.args.includes("--no-recurse-submodules"));
  assert.ok(clone.args.some((arg) => arg.startsWith("--template=")));
  assert.ok(clone.args.includes("core.hooksPath=/dev/null"));
  assert.ok(clone.args.includes("core.fsmonitor=false"));
  assert.ok(clone.args.includes("core.attributesFile=/dev/null"));
  assert.ok(clone.args.includes("core.excludesFile=/dev/null"));
  assert.ok(clone.args.includes("credential.helper="));
  assert.ok(clone.args.includes("credential.interactive=false"));
  assert.ok(clone.args.includes("submodule.recurse=false"));
  assert.ok(clone.args.includes("filter.lfs.smudge="));
  assert.ok(clone.args.includes("protocol.file.allow=never"));
  assert.equal(clone.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(clone.env.GCM_INTERACTIVE, "never");
  assert.equal(clone.env.GIT_LFS_SKIP_SMUDGE, "1");
  assert.equal(clone.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(clone.env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(clone.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(clone.env.GIT_ATTR_NOSYSTEM, "1");
  assert.equal(clone.env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(clone.env.GIT_PROTOCOL_FROM_USER, "0");
  await assert.rejects(readFile(hostile.marker), (error) => error.code === "ENOENT");

  await writeFile(path.join(remote.work, "README.md"), "# Refreshed default branch\n", "utf8");
  runGit(["-C", remote.work, "add", "README.md"], remote.sandbox);
  runGit(["-C", remote.work, "commit", "--quiet", "-m", "refresh"], remote.sandbox);
  runGit(["-C", remote.work, "push", "--quiet", "origin", "main"], remote.sandbox);
  const secondRevision = runGit(["-C", remote.work, "rev-parse", "HEAD"], remote.sandbox);

  const callsBeforeSecond = calls.length;
  const second = await resolvePublicGithubSource("https://github.com/acme/repo2skill-fixture.git", {
    cacheRoot: remote.cacheRoot,
    gitRunner,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  });
  assert.equal(second.cacheHit, true);
  assert.equal(second.cacheKey, first.cacheKey);
  assert.equal(second.repoPath, first.repoPath);
  assert.equal(second.revision, secondRevision);
  assert.notEqual(second.revision, first.revision);
  assert.equal(await readFile(path.join(second.repoPath, "README.md"), "utf8"), "# Refreshed default branch\n");
  const secondCalls = calls.slice(callsBeforeSecond);
  assert.ok(secondCalls.some((call) => call.args.includes("clone")), "cache hits must rebuild from the canonical URL in a fresh directory");
  assert.ok(!secondCalls.some((call) => call.args.includes(first.repoPath)), "no Git command may inspect the existing cache checkout");
  assert.ok(!secondCalls.some((call) => call.args.includes("fetch")), "an existing cache checkout must never be refreshed in place");
  assert.ok(calls.every((call) => call.args.includes("core.hooksPath=/dev/null")));
  assert.ok(calls.every((call) => call.args.includes("core.fsmonitor=false")));
  assert.ok(calls.every((call) => call.args.includes("core.attributesFile=/dev/null")));
  assert.ok(calls.every((call) => call.env.GIT_OPTIONAL_LOCKS === "0"));
  await assert.rejects(readFile(hostile.marker), (error) => error.code === "ENOENT");
});

test("a modified cache is discarded without being mixed with or passed to Git", async (t) => {
  const remote = await localRemote(t);
  const calls = [];
  const gitRunner = offlineGitRunner(remote.bare, calls);
  const first = await resolvePublicGithubSource(PUBLIC_URL, { cacheRoot: remote.cacheRoot, gitRunner, timeoutMs: 10_000 });
  await writeFile(path.join(first.repoPath, "untrusted-local-file.txt"), "must not be analyzed\n", "utf8");
  const callsBeforeSecond = calls.length;
  const second = await resolvePublicGithubSource(PUBLIC_URL, { cacheRoot: remote.cacheRoot, gitRunner, timeoutMs: 10_000 });
  assert.equal(second.cacheHit, true);
  await assert.rejects(readFile(path.join(second.repoPath, "untrusted-local-file.txt")), (error) => error.code === "ENOENT");
  assert.ok(!calls.slice(callsBeforeSecond).some((call) => call.args.includes(first.repoPath)));
});

test("ignored files in local or cached public worktrees never enter the analysis snapshot", async (t) => {
  const remote = await localRemote(t);
  const calls = [];
  const gitRunner = offlineGitRunner(remote.bare, calls);
  const first = await resolvePublicGithubSource(PUBLIC_URL, {
    cacheRoot: remote.cacheRoot,
    gitRunner,
    timeoutMs: 10_000
  });
  await writeFile(path.join(first.repoPath, "ignored.env"), "SHOULD_NOT_BE_SCANNED=secret\n", "utf8");
  const second = await resolvePublicGithubSource(PUBLIC_URL, {
    cacheRoot: remote.cacheRoot,
    gitRunner,
    timeoutMs: 10_000
  });
  const lock = await lockRepository(second.repoPath);
  assert.equal(lock.dirty, false);
  assert.equal(lock.files.some((file) => file.path === "ignored.env"), false);
  assert.equal(lock.files.some((file) => file.text.includes("SHOULD_NOT_BE_SCANNED")), false);
});

test("cache control-plane pollution is blocked before any Git command can inspect it", async (t) => {
  for (const poisonedPath of [".git/config", ".git/info/attributes", ".git/hooks/post-checkout"]) {
    await t.test(poisonedPath, async () => {
      const remote = await localRemote(t);
      const calls = [];
      const gitRunner = offlineGitRunner(remote.bare, calls);
      const first = await resolvePublicGithubSource(PUBLIC_URL, {
        cacheRoot: remote.cacheRoot,
        gitRunner,
        timeoutMs: 10_000
      });
      const target = path.join(first.repoPath, ...poisonedPath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      if (poisonedPath === ".git/config") {
        await writeFile(target, `${await readFile(target, "utf8")}\n[core]\n\tfsmonitor = /tmp/evil\n`, "utf8");
      } else {
        await writeFile(target, "malicious-control-plane\n", "utf8");
      }
      const callsBeforeValidation = calls.length;
      await assert.rejects(
        resolvePublicGithubSource(PUBLIC_URL, {
          cacheRoot: remote.cacheRoot,
          gitRunner,
          timeoutMs: 10_000
        }),
        (error) => error instanceof GithubSourceError && error.code === "CACHE_UNSAFE"
      );
      assert.equal(calls.length, callsBeforeValidation, "polluted control files must be rejected before invoking Git");
    });
  }
});

test("jointly forged cache metadata and Git filters are never executed", async (t) => {
  const remote = await localRemote(t);
  const calls = [];
  const gitRunner = offlineGitRunner(remote.bare, calls);
  const first = await resolvePublicGithubSource(PUBLIC_URL, {
    cacheRoot: remote.cacheRoot,
    gitRunner,
    timeoutMs: 10_000
  });
  const entry = path.dirname(first.repoPath);
  const marker = path.join(remote.sandbox, "forged-filter-executed");
  const filter = path.join(remote.sandbox, "forged-filter.sh");
  await writeFile(filter, `#!/bin/sh\ncat\nprintf executed >> '${marker}'\n`, "utf8");
  await chmod(filter, 0o755);
  await mkdir(path.join(first.repoPath, ".git", "info"), { recursive: true });
  await writeFile(path.join(first.repoPath, ".git", "info", "attributes"), "README.md filter=forged\n", "utf8");
  await writeFile(path.join(first.repoPath, ".git", "config"), `${await readFile(path.join(first.repoPath, ".git", "config"), "utf8")}\n[filter "forged"]\n\tclean = ${filter}\n\tsmudge = ${filter}\n\trequired = true\n`, "utf8");
  const metadataPath = path.join(entry, "repo2skill-source.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.controlPlane = await gitControlPlane(first.repoPath);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const callsBeforeSecond = calls.length;
  const second = await resolvePublicGithubSource(PUBLIC_URL, {
    cacheRoot: remote.cacheRoot,
    gitRunner,
    timeoutMs: 10_000
  });
  assert.equal(second.cacheHit, true);
  await assert.rejects(readFile(marker), (error) => error.code === "ENOENT");
  assert.ok(!calls.slice(callsBeforeSecond).some((call) => call.args.includes(first.repoPath)), "jointly forged old cache files must never be passed to Git");
  assert.ok(!(await readFile(path.join(second.repoPath, ".git", "config"), "utf8")).includes("filter \"forged\""));
});

test("atomic metadata refresh neither follows temporary nor final metadata symlinks", async (t) => {
  const remote = await localRemote(t);
  const gitRunner = offlineGitRunner(remote.bare, []);
  const first = await resolvePublicGithubSource(PUBLIC_URL, {
    cacheRoot: remote.cacheRoot,
    gitRunner,
    timeoutMs: 10_000
  });
  const entry = path.dirname(first.repoPath);
  const outside = path.join(remote.sandbox, "outside-metadata.txt");
  await writeFile(outside, "outside-must-not-change\n", "utf8");
  await symlink(outside, path.join(entry, "repo2skill-source.json.tmp"));

  await resolvePublicGithubSource(PUBLIC_URL, {
    cacheRoot: remote.cacheRoot,
    gitRunner,
    timeoutMs: 10_000
  });
  assert.equal(await readFile(outside, "utf8"), "outside-must-not-change\n");
  await assert.rejects(lstat(path.join(entry, "repo2skill-source.json.tmp")), (error) => error.code === "ENOENT");

  const metadata = path.join(entry, "repo2skill-source.json");
  await rm(metadata);
  await symlink(outside, metadata);
  await assert.rejects(
    resolvePublicGithubSource(PUBLIC_URL, {
      cacheRoot: remote.cacheRoot,
      gitRunner,
      timeoutMs: 10_000
    }),
    (error) => error instanceof GithubSourceError && error.code === "CACHE_UNSAFE"
  );
  assert.equal(await readFile(outside, "utf8"), "outside-must-not-change\n");
});

test("public GitHub source flows through inspection, generation, and target adaptation", async (t) => {
  const remote = await localRemote(t);
  const calls = [];
  const gitRunner = offlineGitRunner(remote.bare, calls);
  const sourceOptions = { cacheRoot: remote.cacheRoot, gitRunner, timeoutMs: 10_000 };
  const analysis = await inspectRepository(PUBLIC_URL, { sourceOptions });
  assert.equal(analysis.inputSource.kind, "github");
  assert.equal(analysis.inputSource.canonicalUrl, CANONICAL_URL);
  assert.equal(analysis.lock.dirty, false);
  assert.ok(analysis.workflows.length >= 3);

  const output = path.join(remote.sandbox, "generated-skill");
  const generated = await generatePackage(PUBLIC_URL, output, { target: "codex", sourceOptions });
  assert.equal(generated.agent.target, "codex");
  assert.notEqual(generated.validation.status, "blocked");
  const sourceMap = JSON.parse(await readFile(path.join(output, "references", "source-map.json"), "utf8"));
  assert.equal(sourceMap.repository.inputKind, "github");
  assert.equal(sourceMap.repository.canonicalUrl, CANONICAL_URL);
  assert.equal(JSON.parse(await readFile(path.join(output, "agents", "target.json"), "utf8")).target, "codex");
  assert.ok(calls.every((call) => !call.args.some((arg) => /(?:npm|node|make|mvn|gradle|python)/.test(arg))));
});

test("Git failures expose only bounded diagnostic output and option limits cannot be disabled", async (t) => {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "repo2skill-source-failure-"));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const failingRunner = () => ({ status: 1, stdout: "", stderr: `remote failure ${"x".repeat(20_000)}` });
  await assert.rejects(
    resolvePublicGithubSource(PUBLIC_URL, { cacheRoot, gitRunner: failingRunner, timeoutMs: 1_000, maxOutputBytes: 1_024 }),
    (error) => error instanceof GithubSourceError && error.code === "GIT_FAILED" && error.message.length < 2_200
  );
  await assert.rejects(
    resolvePublicGithubSource(PUBLIC_URL, { cacheRoot, gitRunner: failingRunner, timeoutMs: 300_001 }),
    /timeoutMs/
  );
  await assert.rejects(
    resolvePublicGithubSource(PUBLIC_URL, { cacheRoot, gitRunner: failingRunner, maxOutputBytes: 1024 * 1024 + 1 }),
    /maxOutputBytes/
  );
});
