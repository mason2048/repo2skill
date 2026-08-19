import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePackageFromPreview, inspectRepository, publicInspection, validatePackage } from "./compiler.js";
import { inspectSkillStaleness, writeStalenessReport } from "./diff.js";
import { writeValidationReport } from "./reports.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_ROOT = path.join(ROOT, "ui");
const MAX_BODY_BYTES = 64 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'"
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function bodyJson(request) {
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0];
  if (contentType !== "application/json") throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body exceeds 64 KiB"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw Object.assign(new Error("Request body must be a JSON object"), { status: 400 });
    }
    return value;
  } catch {
    throw Object.assign(new Error("Request body must be a valid JSON object"), { status: 400 });
  }
}

function assertLocalOrigin(request, requireOrigin = false) {
  const denied = () => Object.assign(new Error("Only same-origin loopback requests are allowed"), { status: 403 });
  let host;
  try { host = new URL(`http://${request.headers.host || ""}`); } catch { throw denied(); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) throw denied();
  const localPort = Number(request.socket.localPort);
  const hostPort = Number(host.port || 80);
  if (!Number.isInteger(localPort) || hostPort !== localPort) throw denied();

  const origin = request.headers.origin;
  if (!origin) {
    if (requireOrigin) throw denied();
    return;
  }
  let parsed;
  try { parsed = new URL(origin); } catch { throw denied(); }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw denied();
  if (parsed.host.toLowerCase() !== host.host.toLowerCase()) throw denied();
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(`${label} is required`), { status: 400 });
  if (value.includes("\0")) throw Object.assign(new Error(`${label} contains an invalid null byte`), { status: 400 });
  return value.trim();
}

async function sourcePath(input) {
  const source = requiredString(input, "repository");
  return source;
}

function checkedSource(body, repository) {
  if (!["local", "github"].includes(body.sourceType)) {
    throw Object.assign(new Error("sourceType must be local or github"), { status: 400 });
  }
  const urlLike = /^(?:https?|git|ssh|file):|^git@/i.test(repository);
  if (body.sourceType === "github" && !/^https:\/\/github\.com\//i.test(repository)) {
    throw Object.assign(new Error("Public GitHub source requires a github.com HTTPS URL"), { status: 400 });
  }
  if (body.sourceType === "local" && urlLike) {
    throw Object.assign(new Error("Local source requires a filesystem repository path"), { status: 400 });
  }
  return repository;
}

async function api(request, response, pathname) {
  assertLocalOrigin(request, request.method !== "GET");
  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { status: "ok", version: "0.3.0", boundary: "loopback-only; repository code is never executed" });
    return;
  }
  if (request.method !== "POST") {
    sendError(response, 405, "Method not allowed");
    return;
  }
  const body = await bodyJson(request);
  if (pathname === "/api/inspect") {
    const repository = checkedSource(body, await sourcePath(body.repository));
    const analysis = await inspectRepository(repository, { excludedIds: Array.isArray(body.excludedIds) ? body.excludedIds : [] });
    sendJson(response, 200, publicInspection(analysis));
    return;
  }
  if (pathname === "/api/generate") {
    const repository = checkedSource(body, await sourcePath(body.repository));
    const output = requiredString(body.output, "output");
    const result = await generatePackageFromPreview(repository, output, {
      excludedIds: Array.isArray(body.excludedIds) ? body.excludedIds : [],
      target: body.target || "generic",
      expectedRepository: requiredString(body.expectedRepository, "expectedRepository"),
      expectedRevision: requiredString(body.expectedRevision, "expectedRevision"),
      expectedSnapshotHash: requiredString(body.expectedSnapshotHash, "expectedSnapshotHash"),
      expectedSource: body.expectedSource && typeof body.expectedSource === "object" ? body.expectedSource : null
    });
    sendJson(response, result.validation.status === "blocked" ? 422 : 200, { output: result.outputPath, target: result.agent.metadata, validation: result.validation });
    return;
  }
  if (pathname === "/api/staleness") {
    const repository = checkedSource(body, await sourcePath(body.repository));
    const skill = requiredString(body.skill, "skill");
    const report = await inspectSkillStaleness(repository, skill);
    const reportPath = await writeStalenessReport(skill, report);
    sendJson(response, report.status === "blocked" ? 422 : 200, { ...report, reportPath });
    return;
  }
  if (pathname === "/api/validate") {
    const repository = checkedSource(body, await sourcePath(body.repository));
    const skill = requiredString(body.skill, "skill");
    const validation = await validatePackage(repository, skill);
    const reportPath = await writeValidationReport(skill, validation);
    sendJson(response, validation.status === "blocked" ? 422 : 200, { ...validation, reportPath });
    return;
  }
  sendError(response, 404, "API endpoint not found");
}

async function staticFile(response, pathname, uiRoot = UI_ROOT) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = path.normalize(relative);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    sendError(response, 404, "Not found");
    return;
  }
  const target = path.join(uiRoot, normalized);
  let info;
  try { info = await lstat(target); } catch { sendError(response, 404, "Not found"); return; }
  if (!info.isFile() || info.isSymbolicLink()) { sendError(response, 404, "Not found"); return; }
  const realRoot = await realpath(uiRoot);
  const realTarget = await realpath(target);
  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) { sendError(response, 404, "Not found"); return; }
  response.writeHead(200, {
    "content-type": MIME[path.extname(target)] || "application/octet-stream",
    "content-length": info.size,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  });
  if (response.req?.method === "HEAD") response.end();
  else createReadStream(target).pipe(response);
}

export function createRepo2SkillHandler({ uiRoot = UI_ROOT } = {}) {
  return async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) await api(request, response, url.pathname);
      else if (request.method === "GET" || request.method === "HEAD") await staticFile(response, url.pathname, uiRoot);
      else sendError(response, 405, "Method not allowed");
    } catch (error) {
      sendError(response, error.status || 500, error.status ? error.message : "Local server request failed");
    }
  };
}

export function createRepo2SkillServer() {
  return createServer(createRepo2SkillHandler());
}

export async function startServer({ host = "127.0.0.1", port = 4173 } = {}) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Repo2Skill UI may only bind to a loopback address");
  const server = createRepo2SkillServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return { server, url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4173;
  startServer({ port }).then(({ url }) => {
    console.log(`Repo2Skill UI: ${url}`);
    console.log("Loopback only. Repository scripts and commands are never executed.");
  }).catch((error) => {
    console.error(`Repo2Skill server error: ${error.message}`);
    process.exitCode = 1;
  });
}
