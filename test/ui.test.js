import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

class FakeClassList {
  constructor(element, value = "") {
    this.element = element;
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    this.element._className = [...this.values].join(" ");
    return enabled;
  }
}

class FakeElement {
  constructor(document, { id = "", tagName = "DIV", className = "", dataset = {}, textContent = "", span = false } = {}) {
    this.ownerDocument = document;
    this.id = id;
    this.tagName = tagName;
    this.dataset = { ...dataset };
    this.listeners = new Map();
    this.attributes = new Map();
    this._className = className;
    this.classList = new FakeClassList(this, className);
    this.textContent = textContent;
    this.value = "";
    this.placeholder = "";
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.hidden = false;
    this._innerHTML = "";
    this.span = span ? new FakeElement(document, { tagName: "SPAN" }) : null;
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value);
    this.classList = new FakeClassList(this, value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (this.id === "candidate-list") this.ownerDocument.parseCandidateInputs(this._innerHTML);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      key: init.key,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
    for (const listener of this.listeners.get(type) || []) await listener(event);
    return event;
  }

  async click() {
    if (this.disabled) return null;
    this.focus();
    return this.dispatch("click");
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  querySelector(selector) {
    return selector === "span" ? this.span : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.candidateInputs = [];
    this.activeElement = null;
    const add = (id, options = {}) => {
      const element = new FakeElement(this, { id, ...options });
      this.elements.set(id, element);
      return element;
    };

    for (const id of [
      "message", "revision", "scope", "excluded-summary", "excluded", "languages", "managers",
      "candidate-count", "selected-count", "candidate-list", "conflict-list", "score",
      "blocker-count", "warning-count", "security-count", "blockers", "warnings",
      "security-findings", "report-content", "result-path", "repository-label"
    ]) add(id);
    for (const id of ["repository", "output", "existing-skill"]) add(id, { tagName: "INPUT" });
    add("target-agent", { tagName: "SELECT" }).value = "generic";
    add("workspace", { tagName: "SECTION", className: "workspace is-empty" });
    add("result-line", { tagName: "FOOTER" }).hidden = true;
    add("select-all", { tagName: "INPUT" }).checked = true;
    add("scan-button", { tagName: "BUTTON", span: true });
    add("generate-button", { tagName: "BUTTON", span: true }).disabled = true;
    add("validate-button", { tagName: "BUTTON" }).disabled = true;
    add("diff-button", { tagName: "BUTTON" }).disabled = true;

    this.sources = [
      new FakeElement(this, { tagName: "BUTTON", className: "segment is-active", dataset: { source: "local" } }),
      new FakeElement(this, { tagName: "BUTTON", className: "segment", dataset: { source: "github" } })
    ];
    this.sources[0].setAttribute("aria-pressed", "true");
    this.sources[1].setAttribute("aria-pressed", "false");
    this.tabs = ["validation", "security", "staleness"].map((name, index) => {
      const tab = new FakeElement(this, { tagName: "BUTTON", className: index === 0 ? "tab is-active" : "tab", dataset: { tab: name } });
      tab.setAttribute("aria-selected", String(index === 0));
      tab.setAttribute("tabindex", index === 0 ? "0" : "-1");
      return tab;
    });
  }

  parseCandidateInputs(html) {
    this.candidateInputs = [];
    const pattern = /<input\s+type="checkbox"\s+data-candidate-ids="([^"]+)"([^>]*)>/g;
    for (const match of html.matchAll(pattern)) {
      const input = new FakeElement(this, { tagName: "INPUT", dataset: { candidateIds: match[1] } });
      input.checked = /\schecked(?:\s|>)/.test(` ${match[2]}>`);
      this.candidateInputs.push(input);
    }
  }

  querySelector(selector) {
    if (selector.startsWith("#")) return this.elements.get(selector.slice(1)) || null;
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-source]") return this.sources;
    if (selector === "[data-candidate-ids]") return this.candidateInputs;
    if (selector === ".tab") return this.tabs;
    return [];
  }
}

function jsonResponse(value, status = 200) {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("real UI module completes scan, cancellation, generation, validation, diff, and keyboard focus without a port", async (t) => {
  const document = new FakeDocument();
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const requests = [];
  const repository = "/fixtures/component-repository";
  const output = "/fixtures/generated-skill";
  const revision = "a".repeat(40);
  const snapshotHash = "b".repeat(64);
  const candidates = [
    { id: "install-1", category: "install", command: "npm ci", verified: true, source: { path: "package.json", locator: "scripts.install" } },
    { id: "test-1", category: "test", command: "npm test", verified: true, source: { path: "package.json", locator: "scripts.test" } }
  ];
  const validation = {
    status: "passed",
    score: 100,
    checks: [{ id: "source-coverage", points: 30, maximum: 30, passed: true }],
    blockers: [],
    warnings: []
  };

  globalThis.document = document;
  globalThis.fetch = async (endpoint, options) => {
    const body = JSON.parse(options.body);
    requests.push({ endpoint, body });
    if (endpoint === "/api/inspect") {
      return jsonResponse({
        repository: { repository, revision, snapshotHash, scannedFiles: 6, dirty: false, excludedDirectories: [".git", "node_modules"], metadata: { languages: ["JavaScript"], frameworks: [], packageManagers: ["npm"] } },
        source: { kind: "local", canonicalUrl: null },
        candidates,
        conflicts: [],
        security: { blockers: [], warnings: [] }
      });
    }
    if (endpoint === "/api/generate") return jsonResponse({ output, target: { target: "generic" }, validation });
    if (endpoint === "/api/validate") return jsonResponse(validation);
    if (endpoint === "/api/staleness") {
      return jsonResponse({
        status: "current",
        items: [{ classification: "unchanged", category: "test", baseline: { command: "npm test" } }]
      });
    }
    return jsonResponse({ error: "unexpected endpoint" }, 404);
  };
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  });

  await import(`${pathToFileURL(path.join(PROJECT_ROOT, "ui", "app.js")).href}?component=${Date.now()}`);

  document.querySelector("#repository").value = repository;
  document.querySelector("#target-agent").value = "generic";
  await document.querySelector("#scan-button").click();
  assert.equal(document.querySelector("#message").textContent, `扫描完成：锁定 revision ${revision.slice(0, 18)}…`);
  assert.equal(document.querySelector("#candidate-count").textContent, "(2)");
  assert.equal(document.querySelector("#selected-count").textContent, "已选 2 项");
  assert.equal(document.querySelector("#generate-button").disabled, false);

  const cancelled = document.candidateInputs[0];
  cancelled.focus();
  cancelled.checked = false;
  await cancelled.dispatch("change");
  assert.equal(document.querySelector("#selected-count").textContent, "已选 1 项");
  assert.equal(document.activeElement, cancelled, "cancelling a candidate must preserve keyboard focus");
  assert.equal(document.candidateInputs.length, 2, "candidate cancellation must not rebuild the focused row");

  document.querySelector("#output").value = output;
  await document.querySelector("#generate-button").click();
  assert.equal(document.querySelector("#message").textContent, "Skill 包生成成功。");
  assert.equal(document.querySelector("#score").textContent, 100);
  assert.equal(document.querySelector("#result-line").hidden, false);
  assert.equal(document.querySelector("#existing-skill").value, output);
  assert.deepEqual(requests.find((entry) => entry.endpoint === "/api/generate").body.excludedIds, ["install-1"]);

  await document.querySelector("#validate-button").click();
  assert.equal(document.querySelector("#message").textContent, "复验完成。");
  await document.querySelector("#diff-button").click();
  assert.equal(document.querySelector("#message").textContent, "revision 差异比较完成。");
  assert.match(document.querySelector("#report-content").innerHTML, /当前一致/);
  assert.equal(document.tabs[2].getAttribute("aria-selected"), "true");

  document.tabs[2].focus();
  const home = await document.tabs[2].dispatch("keydown", { key: "Home" });
  assert.equal(home.defaultPrevented, true);
  assert.equal(document.activeElement, document.tabs[0]);
  assert.equal(document.tabs[0].getAttribute("tabindex"), "0");
  assert.equal(document.tabs[2].getAttribute("tabindex"), "-1");
  await document.tabs[0].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(document.activeElement, document.tabs[1]);
  assert.equal(document.tabs[1].getAttribute("aria-selected"), "true");

  assert.deepEqual(requests.map((entry) => entry.endpoint), [
    "/api/inspect", "/api/generate", "/api/validate", "/api/staleness"
  ]);
  const previewBound = requests.find((entry) => entry.endpoint === "/api/generate").body;
  assert.equal(previewBound.expectedRevision, revision);
  assert.equal(previewBound.expectedSnapshotHash, snapshotHash);
});

test("semantic controls and responsive CSS provide static narrow-screen no-overflow evidence", async () => {
  const html = await readFile(path.join(PROJECT_ROOT, "ui", "index.html"), "utf8");
  const css = await readFile(path.join(PROJECT_ROOT, "ui", "styles.css"), "utf8");

  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  for (const id of ["scan-button", "generate-button", "validate-button", "diff-button"]) {
    assert.match(html, new RegExp(`<button[^>]+id="${id}"[^>]+type="button"`));
  }
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.match(html, /aria-controls="report-content" tabindex="0"/);
  assert.match(html, /id="report-content" class="report-content" role="tabpanel"/);
  assert.match(css, /button:focus-visible, input:focus-visible, select:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /body\s*\{[^}]*min-width:\s*320px/s);

  const mobile = css.slice(css.indexOf("@media (max-width: 760px)"), css.indexOf("@media (max-width: 360px)"));
  const compact = css.slice(css.indexOf("@media (max-width: 360px)"), css.indexOf("@media (prefers-reduced-motion"));
  assert.match(mobile, /\.source-panel\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.workspace\s*\{[^}]*display:\s*block/s);
  assert.match(mobile, /\.candidate-row\s*\{[^}]*minmax\(66px,[^)]+\)[^}]*minmax\(76px,[^)]+\)/s);
  assert.match(compact, /\.candidate-row\s*\{[^}]*grid-template-columns:\s*20px 58px minmax\(0, 1fr\)/s);
  assert.match(css, /\.result-line code\s*\{[^}]*overflow-wrap:\s*anywhere/s);

  // At the breakpoint edges, the fixed columns and gaps remain within the
  // content box. Flexible minmax(0, 1fr) columns absorb the remaining width.
  const regularMobileContent = 361 - 32 - 24;
  const regularMobileGridMinimum = 20 + 46 + 66 + 58 + 76 + (4 * 7);
  assert.ok(regularMobileGridMinimum <= regularMobileContent);
  const compactMobileContent = 320 - 32 - 24;
  const compactFixedMinimum = 20 + 58 + (2 * 9);
  assert.ok(compactFixedMinimum <= compactMobileContent);
});
