import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CACHE_VERSION = 1;
const CACHE_NAMESPACE = `github-v${CACHE_VERSION}`;
const METADATA_FILE = "repo2skill-source.json";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const MAX_OUTPUT_LIMIT = 1024 * 1024;
const ERROR_DETAIL_LIMIT = 2_000;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/;
const CONTROL_MANIFEST_VERSION = 1;
const MAX_CONTROL_ENTRIES = 100_000;

export class GithubSourceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "GithubSourceError";
    this.code = code;
  }
}

function invalidUrl(reason) {
  throw new GithubSourceError(
    "INVALID_GITHUB_URL",
    `Only a public https://github.com/<owner>/<repo>[.git] URL is accepted (${reason})`
  );
}

/**
 * Strictly validates and canonicalizes a public GitHub repository URL.
 * The returned canonical URL deliberately contains no credentials, query, or fragment.
 */
export function normalizePublicGithubUrl(input) {
  if (typeof input !== "string" || input.length === 0) invalidUrl("URL is required");
  if (input !== input.trim() || /[\u0000-\u0020\u007f]/.test(input)) invalidUrl("whitespace is not allowed");
  if (input.includes("%") || input.includes("\\")) invalidUrl("encoded or backslash paths are not allowed");

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    invalidUrl("malformed URL");
  }
  if (parsed.protocol !== "https:") invalidUrl("HTTPS is required");
  if (parsed.username || parsed.password) invalidUrl("credentials are not allowed");
  if (parsed.hostname.toLowerCase() !== "github.com") invalidUrl("host must be github.com");
  if (parsed.port) invalidUrl("custom ports are not allowed");
  if (parsed.search || parsed.hash) invalidUrl("query strings and fragments are not allowed");

  // Parsing alone is intentionally insufficient: WHATWG URLs normalize several
  // ambiguous spellings. The raw authority/path must match the supported grammar.
  const raw = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)$/i.exec(input);
  if (!raw) invalidUrl("path must contain exactly owner and repository");
  const owner = raw[1];
  let repository = raw[2];
  if (repository.toLowerCase().endsWith(".git")) repository = repository.slice(0, -4);
  if (!OWNER_PATTERN.test(owner)) invalidUrl("invalid owner name");
  if (!REPOSITORY_PATTERN.test(repository) || repository === "." || repository === "..") {
    invalidUrl("invalid repository name");
  }

  const normalizedOwner = owner.toLowerCase();
  const normalizedRepository = repository.toLowerCase();
  return Object.freeze({
    owner: normalizedOwner,
    repository: normalizedRepository,
    canonicalUrl: `https://github.com/${normalizedOwner}/${normalizedRepository}.git`
  });
}

export function githubCacheKey(input) {
  const canonicalUrl = input?.canonicalUrl || normalizePublicGithubUrl(input).canonicalUrl;
  return createHash("sha256").update(canonicalUrl).digest("hex");
}

export function defaultGithubCacheRoot() {
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Caches", "repo2skill");
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || tmpdir(), "repo2skill-cache");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "repo2skill");
}

function normalizeLimits(options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer between 1000 and ${MAX_TIMEOUT_MS}`);
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > MAX_OUTPUT_LIMIT) {
    throw new TypeError(`maxOutputBytes must be an integer between 1024 and ${MAX_OUTPUT_LIMIT}`);
  }
  return { timeoutMs, maxOutputBytes };
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
    "-c", "http.followRedirects=false",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=0",
    "-c", "core.pager=cat",
    ...args
  ];
}

export function defaultGitRunner({ args, cwd, env, timeoutMs, maxOutputBytes }) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    windowsHide: true
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error
  };
}

function safeDetail(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, ERROR_DETAIL_LIMIT);
}

async function executeGit(gitRunner, args, { cwd, timeoutMs, maxOutputBytes, operation }) {
  let result;
  try {
    result = await gitRunner({
      args: safeGitArgs(args),
      cwd,
      env: controlledGitEnvironment(),
      timeoutMs,
      maxOutputBytes
    });
  } catch (error) {
    throw new GithubSourceError("GIT_FAILED", `Git ${operation} failed without executing repository code`, { cause: error });
  }
  if (result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM") {
    throw new GithubSourceError("GIT_TIMEOUT", `Git ${operation} exceeded the ${timeoutMs} ms limit`);
  }
  if (!result || result.status !== 0) {
    const detail = safeDetail(result?.stderr || result?.error?.message);
    throw new GithubSourceError(
      "GIT_FAILED",
      `Git ${operation} failed without executing repository code${detail ? `: ${detail}` : ""}`
    );
  }
  return String(result.stdout || "").trim();
}

async function directoryKind(target) {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function prepareCacheRoot(cacheRoot) {
  const requested = path.resolve(cacheRoot || defaultGithubCacheRoot());
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const resolvedRoot = await realpath(requested);
  const namespace = path.join(resolvedRoot, CACHE_NAMESPACE);
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  if (await directoryKind(namespace) !== "directory") {
    throw new GithubSourceError("CACHE_UNSAFE", "GitHub cache namespace must be a real directory, not a link or file");
  }
  return { cacheRoot: resolvedRoot, namespace };
}

async function snapshotGitControlPlane(repositoryPath) {
  const gitDirectory = path.join(repositoryPath, ".git");
  if (await directoryKind(gitDirectory) !== "directory") {
    throw new GithubSourceError("CACHE_UNSAFE", "Cached checkout must contain a real .git directory");
  }
  const entries = [];
  async function walk(current, relativeDirectory = "") {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const absolute = path.join(current, child.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new GithubSourceError("CACHE_UNSAFE", `Cached Git control path is a symbolic link: .git/${relative}`);
      }
      const entry = {
        path: `.git/${relative}`,
        mode: stat.mode & 0o777,
        kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other"
      };
      if (entry.kind === "other") {
        throw new GithubSourceError("CACHE_UNSAFE", `Cached Git control path has an unsupported type: ${entry.path}`);
      }
      if (stat.isFile()) {
        entry.size = stat.size;
        // Git object names are content-addressed and verified by Git. Recording
        // their paths, size and type catches link substitution without hashing
        // arbitrarily large packfiles on every cache hit. Every executable or
        // configuration-bearing path outside objects is hashed byte-for-byte.
        if (!relative.startsWith("objects/")) {
          entry.hash = createHash("sha256").update(await readFile(absolute)).digest("hex");
        }
      }
      entries.push(entry);
      if (entries.length > MAX_CONTROL_ENTRIES) {
        throw new GithubSourceError("CACHE_UNSAFE", "Cached Git control plane exceeds the safety limit");
      }
      if (stat.isDirectory()) await walk(absolute, relative);
    }
  }
  await walk(gitDirectory);
  return Object.freeze({
    version: CONTROL_MANIFEST_VERSION,
    entryCount: entries.length,
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex")
  });
}

async function assertGitControlPlane(repositoryPath, expected) {
  if (
    !expected ||
    expected.version !== CONTROL_MANIFEST_VERSION ||
    !Number.isInteger(expected.entryCount) ||
    !/^[0-9a-f]{64}$/.test(expected.digest || "")
  ) {
    throw new GithubSourceError("CACHE_UNSAFE", "Cached Git control-plane metadata is missing or invalid");
  }
  const actual = await snapshotGitControlPlane(repositoryPath);
  if (actual.entryCount !== expected.entryCount || actual.digest !== expected.digest) {
    throw new GithubSourceError(
      "CACHE_UNSAFE",
      "Cached Git control files changed; refusing to invoke Git or touch the checkout"
    );
  }
}

async function acquireCacheLock(namespace, key, timeoutMs) {
  const lockPath = path.join(namespace, `${key}.lock`);
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => {
        try {
          await rmdir(lockPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new GithubSourceError("CACHE_BUSY", "Another process is refreshing this GitHub cache entry");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function writeMetadata(entryPath, metadata) {
  if (await directoryKind(entryPath) !== "directory") {
    throw new GithubSourceError("CACHE_UNSAFE", "GitHub cache entry must be a real directory");
  }
  const resolvedEntry = await realpath(entryPath);
  const target = path.join(resolvedEntry, METADATA_FILE);
  const targetKind = await directoryKind(target);
  if (targetKind !== "missing" && targetKind !== "file") {
    throw new GithubSourceError("CACHE_UNSAFE", "GitHub cache metadata target must not be a link or directory");
  }
  const temporary = path.join(resolvedEntry, `.${METADATA_FILE}.${randomBytes(12).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function validateCacheEntry(entryPath, canonicalUrl, key) {
  if (await directoryKind(entryPath) !== "directory") {
    throw new GithubSourceError("CACHE_UNSAFE", "Existing GitHub cache entry is not a real directory");
  }
  const metadataPath = path.join(entryPath, METADATA_FILE);
  const repositoryPath = path.join(entryPath, "repository");
  if (await directoryKind(metadataPath) !== "file" || await directoryKind(repositoryPath) !== "directory") {
    throw new GithubSourceError("CACHE_UNSAFE", "Existing GitHub cache entry is incomplete or contains links");
  }
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    throw new GithubSourceError("CACHE_UNSAFE", "Existing GitHub cache metadata is invalid");
  }
  if (metadata.cacheVersion !== CACHE_VERSION || metadata.cacheKey !== key || metadata.canonicalUrl !== canonicalUrl) {
    throw new GithubSourceError("CACHE_UNSAFE", "Existing GitHub cache metadata does not match the requested source");
  }
  // This check is deliberately filesystem-only. More importantly, no Git
  // command is ever run against an existing cache entry: metadata and the Git
  // control plane share one writable trust domain and can be forged together.
  // A cache hit is therefore only a signal to rebuild from the canonical URL
  // in a fresh sibling directory, never authority to reuse the old checkout.
  await assertGitControlPlane(repositoryPath, metadata.controlPlane);
  return { repositoryPath, metadata };
}

async function cloneCacheEntry(namespace, key, normalized, git, limits, { replaceExisting = false } = {}) {
  const temporaryEntry = await mkdtemp(path.join(namespace, `.${key}.tmp-`));
  const repositoryPath = path.join(temporaryEntry, "repository");
  const emptyTemplate = path.join(temporaryEntry, "empty-git-template");
  try {
    await mkdir(emptyTemplate, { mode: 0o700 });
    await executeGit(git, [
      "clone", "--quiet", "--depth=1", "--no-tags", "--single-branch",
      "--no-recurse-submodules", `--template=${emptyTemplate}`,
      normalized.canonicalUrl, repositoryPath
    ], { cwd: namespace, ...limits, operation: "clone" });

    const branch = await executeGit(git, ["-C", repositoryPath, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      ...limits,
      operation: "default branch discovery"
    });
    await validateBranch(branch, git, limits);
    const revision = await readRevision(repositoryPath, git, limits);
    await executeGit(git, ["-C", repositoryPath, "checkout", "--quiet", "--detach", "--force", revision], {
      ...limits,
      operation: "detached checkout"
    });
    await executeGit(git, ["-C", repositoryPath, "remote", "set-url", "origin", normalized.canonicalUrl], {
      ...limits,
      operation: "remote normalization"
    });
    const status = await executeGit(git, ["-C", repositoryPath, "status", "--porcelain=v1", "--untracked-files=all"], {
      ...limits,
      operation: "new cache integrity check"
    });
    if (status) {
      throw new GithubSourceError("CACHE_DIRTY", "New GitHub checkout is not clean");
    }
    const controlPlane = await snapshotGitControlPlane(repositoryPath);
    await writeMetadata(temporaryEntry, {
      cacheVersion: CACHE_VERSION,
      cacheKey: key,
      canonicalUrl: normalized.canonicalUrl,
      defaultBranch: branch,
      revision,
      controlPlane,
      createdAt: new Date().toISOString(),
      refreshedAt: new Date().toISOString()
    });
    const entryPath = path.join(namespace, key);
    if (!replaceExisting) {
      await rename(temporaryEntry, entryPath);
    } else {
      // The per-key lock excludes concurrent readers/writers. Retire the old
      // untrusted entry first, atomically publish the fully validated rebuild,
      // then remove only the explicitly named retired cache directory.
      const retiredEntry = path.join(namespace, `.${key}.retired-${randomBytes(12).toString("hex")}`);
      await rename(entryPath, retiredEntry);
      try {
        await rename(temporaryEntry, entryPath);
      } catch (error) {
        try { await rename(retiredEntry, entryPath); } catch { /* preserve the original replacement error */ }
        throw error;
      }
      await rm(retiredEntry, { recursive: true, force: true });
    }
    return { entryPath, repositoryPath: path.join(entryPath, "repository"), branch, revision };
  } catch (error) {
    await rm(temporaryEntry, { recursive: true, force: true });
    throw error;
  }
}

async function validateBranch(branch, git, limits) {
  if (!branch || branch.includes("\0") || branch.includes("\n") || branch.includes("\r")) {
    throw new GithubSourceError("REMOTE_HEAD_INVALID", "GitHub advertised an invalid default branch");
  }
  await executeGit(git, ["check-ref-format", `refs/heads/${branch}`], {
    ...limits,
    operation: "default branch validation"
  });
}

async function readRevision(repositoryPath, git, limits, reference = "HEAD") {
  const revision = await executeGit(git, ["-C", repositoryPath, "rev-parse", `${reference}^{commit}`], {
    ...limits,
    operation: "revision lock"
  });
  if (!REVISION_PATTERN.test(revision)) {
    throw new GithubSourceError("REMOTE_HEAD_INVALID", "GitHub returned an invalid commit revision");
  }
  return revision;
}

/**
 * Materializes a public GitHub repository in a dedicated cache and returns a
 * clean local checkout intended only for Repo2Skill's read-only static analysis.
 * `gitRunner` is a trusted dependency-injection seam for offline tests.
 */
export async function resolvePublicGithubSource(input, options = {}) {
  const normalized = normalizePublicGithubUrl(input);
  const key = githubCacheKey(normalized);
  const limits = normalizeLimits(options);
  const git = options.gitRunner || defaultGitRunner;
  if (typeof git !== "function") throw new TypeError("gitRunner must be a function");
  const cache = await prepareCacheRoot(options.cacheRoot);
  const entryPath = path.join(cache.namespace, key);
  const releaseLock = await acquireCacheLock(cache.namespace, key, limits.timeoutMs);
  try {
    const cacheHit = await directoryKind(entryPath) !== "missing";
    let repositoryPath;
    let branch;
    let revision;
    if (!cacheHit) {
      ({ repositoryPath, branch, revision } = await cloneCacheEntry(cache.namespace, key, normalized, git, limits));
    } else {
      await validateCacheEntry(entryPath, normalized.canonicalUrl, key);
      ({ repositoryPath, branch, revision } = await cloneCacheEntry(
        cache.namespace, key, normalized, git, limits, { replaceExisting: true }
      ));
    }
    return Object.freeze({
      kind: "github",
      canonicalUrl: normalized.canonicalUrl,
      owner: normalized.owner,
      repository: normalized.repository,
      cacheRoot: cache.cacheRoot,
      cacheKey: key,
      cacheHit,
      repoPath: repositoryPath,
      analysisPath: repositoryPath,
      readOnly: true,
      defaultBranch: branch,
      revision,
      commit: revision,
      dirty: false
    });
  } finally {
    await releaseLock();
  }
}
