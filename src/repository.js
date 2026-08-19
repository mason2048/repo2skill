import { createHash } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "target",
  ".next", ".venv", "venv", "__pycache__", ".idea", ".vscode", "coverage"
]);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  "", ".md", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml",
  ".gradle", ".kts", ".properties", ".ini", ".cfg", ".conf", ".sh", ".bash",
  ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".java"
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function controlledGitEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      name.startsWith("GIT_") ||
      name === "GCM_INTERACTIVE" ||
      name === "GCM_GUI_PROMPT" ||
      name === "SSH_ASKPASS" ||
      name === "SSH_ASKPASS_REQUIRE"
    ) continue;
    env[name] = value;
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = process.platform === "win32" ? "" : "/usr/bin/false";
  env.SSH_ASKPASS_REQUIRE = "never";
  env.GCM_INTERACTIVE = "never";
  env.GCM_GUI_PROMPT = "0";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_SYSTEM = nullDevice;
  env.GIT_CONFIG_GLOBAL = nullDevice;
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PROTOCOL_FROM_USER = "0";
  env.LC_ALL = "C";
  return env;
}

function safeGitArgs(args) {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return [
    "-c", "credential.helper=",
    "-c", "credential.interactive=false",
    "-c", `core.hooksPath=${nullDevice}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "core.splitIndex=false",
    "-c", `core.attributesFile=${nullDevice}`,
    "-c", `core.excludesFile=${nullDevice}`,
    "-c", "filter.lfs.clean=",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.process=",
    "-c", "filter.lfs.required=false",
    "-c", "submodule.recurse=false",
    "-c", "fetch.recurseSubmodules=false",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.file.allow=never",
    "-c", "protocol.ext.allow=never",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=0",
    "-c", "core.pager=cat",
    ...args
  ];
}

function runGit(repoPath, args, { trim = true } = {}) {
  const result = spawnSync("git", [...safeGitArgs([]), "-C", repoPath, ...args], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: controlledGitEnvironment()
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "unknown Git error").trim();
    throw new Error(`Not a readable Git repository: ${detail}`);
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function assertLocalGitConfigSafe(repoPath) {
  // `git config --local --no-includes` only parses the repository config; it
  // does not inspect worktree content or run filters/hooks. Reject executable
  // extension points that cannot be safely neutralized by a finite set of
  // command-line overrides before any status or ls-files operation.
  const output = runGit(repoPath, ["config", "--local", "--no-includes", "--null", "--list"], { trim: false });
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\n");
    const key = (separator >= 0 ? record.slice(0, separator) : record).toLowerCase();
    const unsupported = key === "include.path"
      || key.startsWith("includeif.")
      || (/^filter\..+\.(?:clean|smudge|process|required)$/.test(key) && !key.startsWith("filter.lfs."))
      || /^diff\..+\.(?:command|textconv)$/.test(key)
      || /^merge\..+\.driver$/.test(key);
    if (unsupported) {
      throw new Error(`Not a safely readable Git repository: executable or included local Git configuration is not supported (${key})`);
    }
  }
}

function isExcludedPath(relativePath) {
  return relativePath.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function listRepositoryPaths(repoPath) {
  // This is the single scan-scope contract for both local inputs and cached
  // GitHub inputs: tracked files plus untracked files that Git does not ignore.
  // User-global ignore/config state is disabled above; repository .gitignore
  // and .git/info/exclude remain authoritative for the selected repository.
  const output = runGit(
    repoPath,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { trim: false }
  );
  const files = [];
  for (const relativePath of output.split("\0")) {
    if (!relativePath || isExcludedPath(relativePath)) continue;
    if (
      relativePath.includes("\0") ||
      path.posix.isAbsolute(relativePath) ||
      relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error("Git returned an unsafe repository path");
    }
    files.push(relativePath);
    if (files.length > MAX_FILES) throw new Error(`Repository exceeds the ${MAX_FILES}-file MVP limit`);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function isTextCandidate(relativePath) {
  const base = path.basename(relativePath).toLowerCase();
  if (["makefile", "dockerfile", "jenkinsfile", "procfile"].includes(base)) return true;
  return TEXT_EXTENSIONS.has(path.extname(base));
}

async function snapshotFiles(repoPath) {
  const relativePaths = listRepositoryPaths(repoPath);
  const files = [];
  for (const relativePath of relativePaths) {
    const absolute = path.join(repoPath, ...relativePath.split("/"));
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      // A tracked deletion remains in the index and is intentionally reflected
      // by Git status. It is absent from the content snapshot so validation can
      // report the corresponding source reference as missing.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const resolved = await realpath(absolute);
    if (resolved !== absolute || !resolved.startsWith(`${repoPath}${path.sep}`)) {
      throw new Error(`Repository file resolves outside the repository root: ${relativePath}`);
    }
    if (stat.size > MAX_FILE_BYTES || !isTextCandidate(relativePath)) continue;
    const buffer = await readFile(absolute);
    if (buffer.includes(0)) continue;
    files.push({
      path: relativePath,
      absolute,
      size: stat.size,
      mode: stat.mode,
      hash: sha256(buffer),
      text: buffer.toString("utf8")
    });
  }
  return files;
}

function snapshotHash(files) {
  // Permission changes can alter the safety meaning of a repository file even
  // when its bytes are unchanged (for example, a shell script becoming
  // executable). Keep the portable permission bits in the locked snapshot so
  // dirty-worktree revisions and unchanged assertions cover that transition.
  return sha256(files.map((file) => `${file.path}\0${(file.mode & 0o777).toString(8).padStart(3, "0")}\0${file.hash}`).join("\n"));
}

function gitState(repoPath) {
  const root = runGit(repoPath, ["rev-parse", "--show-toplevel"]);
  const commit = runGit(repoPath, ["rev-parse", "HEAD"]);
  const status = runGit(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { root: path.resolve(root), commit, status, dirty: status.length > 0 };
}

export async function lockRepository(inputPath) {
  const repoPath = await realpath(path.resolve(inputPath));
  const stat = await lstat(repoPath);
  if (!stat.isDirectory()) throw new Error("Repository path must be a directory");
  assertLocalGitConfigSafe(repoPath);
  const beforeGit = gitState(repoPath);
  if (beforeGit.root !== repoPath) {
    throw new Error(`Use the Git repository root as input: ${beforeGit.root}`);
  }
  const files = await snapshotFiles(repoPath);
  const contentHash = snapshotHash(files);
  const afterGit = gitState(repoPath);
  if (beforeGit.commit !== afterGit.commit || beforeGit.status !== afterGit.status) {
    throw new Error("Repository changed while it was being scanned; retry with a stable worktree");
  }
  const revision = beforeGit.dirty
    ? `${beforeGit.commit}+worktree.${contentHash.slice(0, 16)}`
    : beforeGit.commit;
  return {
    repoPath,
    files,
    revision,
    commit: beforeGit.commit,
    dirty: beforeGit.dirty,
    snapshotHash: contentHash,
    excludedDirectories: [...EXCLUDED_DIRECTORIES].sort(),
    limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES }
  };
}

export async function assertRepositoryUnchanged(lock) {
  const current = await lockRepository(lock.repoPath);
  if (current.revision !== lock.revision || current.snapshotHash !== lock.snapshotHash) {
    throw new Error("Repository changed during generation; no package was finalized");
  }
}

export function fileMap(lock) {
  return new Map(lock.files.map((file) => [file.path, file]));
}
