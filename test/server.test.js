import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import test from "node:test";
import { createRepo2SkillHandler, startServer } from "../src/server.js";
import { append, fixtureRepository } from "./helpers.js";

class InProcessResponse extends Writable {
  constructor(request) {
    super();
    this.req = request;
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  result() {
    const body = Buffer.concat(this.chunks).toString("utf8");
    return {
      status: this.statusCode,
      headers: this.headers,
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  }
}

function inProcessClient({ uiRoot } = {}) {
  const handler = createRepo2SkillHandler({ uiRoot });
  return async function request(endpoint, {
    method = "GET",
    body,
    rawBody,
    headers = {},
    localPort = 4173
  } = {}) {
    const payload = rawBody === undefined && body !== undefined ? JSON.stringify(body) : rawBody;
    const requestHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    requestHeaders.host ??= `127.0.0.1:${localPort}`;
    if (body !== undefined && requestHeaders["content-type"] === undefined) requestHeaders["content-type"] = "application/json";
    if (method !== "GET" && !Object.hasOwn(requestHeaders, "origin")) requestHeaders.origin = `http://127.0.0.1:${localPort}`;

    const incoming = Readable.from(payload === undefined ? [] : [Buffer.from(payload)]);
    incoming.method = method;
    incoming.url = endpoint;
    incoming.headers = requestHeaders;
    incoming.socket = { localPort };
    const response = new InProcessResponse(incoming);
    const finished = once(response, "finish");
    await handler(incoming, response);
    await finished;
    return response.result();
  };
}

test("local UI serves hardened static assets and a loopback health boundary", async () => {
  const request = inProcessClient();
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.match(await page.text(), /Repo2Skill/);
  const head = await request("/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.match((await health.json()).boundary, /loopback-only/);
  assert.equal((await request("/missing.css")).status, 404);
  assert.equal((await request("/%2e%2e/package.json")).status, 404);
  assert.equal((await request("/", { method: "POST", body: {} })).status, 405);
  await assert.rejects(startServer({ host: "0.0.0.0", port: 0 }), /loopback/);
});

test("UI API supports inspect, target generation, validation, and persisted staleness", async (t) => {
  const { repo, output } = await fixtureRepository("java", t);
  const request = inProcessClient();
  const inspected = await request("/api/inspect", { method: "POST", body: { repository: repo, sourceType: "local" } });
  assert.equal(inspected.status, 200);
  const preview = await inspected.json();
  assert.ok(preview.candidates.length >= 3);
  const generated = await request("/api/generate", { method: "POST", body: {
    repository: repo,
    sourceType: "local",
    output,
    target: "copilot",
    excludedIds: [],
    expectedRepository: preview.repository.repository,
    expectedRevision: preview.repository.revision,
    expectedSnapshotHash: preview.repository.snapshotHash,
    expectedSource: { kind: preview.source.kind, canonicalUrl: preview.source.canonicalUrl }
  } });
  assert.equal(generated.status, 200);
  const generatedBody = await generated.json();
  assert.equal(generatedBody.target.target, "copilot");
  assert.equal(JSON.parse(await readFile(path.join(output, "agents", "target.json"), "utf8")).target, "copilot");
  const validated = await request("/api/validate", { method: "POST", body: { repository: repo, sourceType: "local", skill: output } });
  assert.equal(validated.status, 200);
  assert.equal((await validated.json()).status, "passed");
  const staleness = await request("/api/staleness", { method: "POST", body: { repository: repo, sourceType: "local", skill: output } });
  assert.equal(staleness.status, 200);
  assert.equal((await staleness.json()).status, "current");
  await access(path.join(output, "reports", "staleness.json"));

  await append(path.join(repo, "pom.xml"), "\n<!-- revision drift -->\n");
  const blockedValidation = await request("/api/validate", { method: "POST", body: { repository: repo, sourceType: "local", skill: output } });
  assert.equal(blockedValidation.status, 422);
  assert.equal((await blockedValidation.json()).status, "blocked");

  await rm(path.join(repo, "Makefile"));
  const blockedStaleness = await request("/api/staleness", { method: "POST", body: { repository: repo, sourceType: "local", skill: output } });
  assert.equal(blockedStaleness.status, 422);
  assert.equal((await blockedStaleness.json()).status, "blocked");
});

test("UI generation refuses a repository that changed after the displayed preview", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  const request = inProcessClient();
  const inspected = await request("/api/inspect", { method: "POST", body: { repository: repo, sourceType: "local" } });
  const preview = await inspected.json();

  await append(path.join(repo, "Makefile"), "\nformat:\n\tblack .\n");
  const generated = await request("/api/generate", { method: "POST", body: {
    repository: repo,
    sourceType: "local",
    output,
    target: "generic",
    excludedIds: [],
    expectedRepository: preview.repository.repository,
    expectedRevision: preview.repository.revision,
    expectedSnapshotHash: preview.repository.snapshotHash,
    expectedSource: { kind: preview.source.kind, canonicalUrl: preview.source.canonicalUrl }
  } });

  assert.equal(generated.status, 409);
  assert.match((await generated.json()).error, /scan again/i);
  await assert.rejects(access(output));
});

test("UI API rejects cross-origin mutation attempts and oversized bodies", async () => {
  const request = inProcessClient();
  const crossOrigin = await request("/api/inspect", {
    method: "POST",
    headers: { origin: "https://attacker.invalid" },
    body: { repository: "/tmp/nope", sourceType: "local" }
  });
  assert.equal(crossOrigin.status, 403);
  const oversized = await request("/api/inspect", {
    method: "POST",
    body: { repository: "x".repeat(70 * 1024), sourceType: "local" }
  });
  assert.equal(oversized.status, 413);

  const nullBody = await request("/api/inspect", { method: "POST", rawBody: "null", headers: { "content-type": "application/json" } });
  assert.equal(nullBody.status, 400);

  for (const origin of [undefined, "null", "http://127.0.0.1:9", "http://localhost:9"]) {
    const headers = origin === undefined ? { origin: undefined } : { origin };
    const response = await request("/api/inspect", {
      method: "POST",
      headers,
      body: { repository: "/tmp/nope", sourceType: "local" }
    });
    assert.equal(response.status, 403, `origin ${origin ?? "missing"} must be rejected`);
  }

  assert.equal((await request("/api/inspect", { method: "POST", body: {}, headers: { host: "attacker.invalid:4173" } })).status, 403);
  assert.equal((await request("/api/inspect", { method: "POST", body: {}, headers: { host: "127.0.0.1:9" } })).status, 403);
  assert.equal((await request("/api/inspect", { method: "POST", rawBody: "{}", headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await request("/api/inspect", { method: "POST", rawBody: "{", headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await request("/api/inspect", { method: "POST", rawBody: "[]", headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await request("/api/unknown", { method: "POST", body: {} })).status, 404);
  assert.equal((await request("/api/unknown")).status, 405);
});

test("UI source selector is enforced by the server", async (t) => {
  const { repo } = await fixtureRepository("node", t);
  const request = inProcessClient();
  const localAsGithub = await request("/api/inspect", { method: "POST", body: { repository: repo, sourceType: "github" } });
  assert.equal(localAsGithub.status, 400);
  assert.match((await localAsGithub.json()).error, /GitHub source/i);

  const githubAsLocal = await request("/api/inspect", { method: "POST", body: { repository: "https://github.com/octocat/Hello-World", sourceType: "local" } });
  assert.equal(githubAsLocal.status, 400);
  assert.match((await githubAsLocal.json()).error, /Local source/i);
});

test("static serving refuses symbolic links outside its configured UI root", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "repo2skill-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "..", `${path.basename(root)}-secret.txt`);
  await writeFile(path.join(root, "index.html"), "safe", "utf8");
  await writeFile(outside, "secret", "utf8");
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(root, "escape.txt"));

  const request = inProcessClient({ uiRoot: root });
  assert.equal((await request("/")).status, 200);
  const escaped = await request("/escape.txt");
  assert.equal(escaped.status, 404);
  assert.doesNotMatch(await escaped.text(), /secret/);
});
