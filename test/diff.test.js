import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { generatePackage, inspectRepository } from "../src/compiler.js";
import { buildStalenessReport, inspectSkillStaleness } from "../src/diff.js";
import { append, fixtureRepository } from "./helpers.js";

test("same revision reports every mapped workflow as unchanged and current", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  await generatePackage(repo, output);

  const report = await inspectSkillStaleness(repo, output);

  assert.equal(report.status, "current");
  assert.equal(report.baseline.revision, report.current.revision);
  assert.equal(report.revisionChanged, false);
  assert.ok(report.summary.total >= 3);
  assert.equal(report.summary.unchanged, report.summary.total);
  assert.equal(report.summary.staleItems, 0);
  assert.equal(report.summary.blockingItems, 0);
  assert.ok(report.items.every((item) => item.classification === "unchanged"));
  assert.ok(report.items.every((item) => item.evidence.sourceFile.state === "unchanged"));
  assert.ok(report.items.every((item) => item.evidence.locator.state === "unchanged"));
  assert.ok(report.items.every((item) => item.evidence.command.state === "unchanged"));
});

test("a referenced source content change is stale with before and after hashes", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  await generatePackage(repo, output);
  await append(path.join(repo, "Makefile"), "\n# changed after Skill generation\n");

  const report = await inspectSkillStaleness(repo, output);

  assert.equal(report.status, "stale");
  assert.equal(report.revisionChanged, true);
  assert.equal(report.summary.changed, report.summary.total);
  for (const item of report.items) {
    assert.equal(item.classification, "changed");
    assert.equal(item.evidence.sourceFile.state, "changed");
    assert.notEqual(item.evidence.sourceFile.baselineHash, item.evidence.sourceFile.currentHash);
    assert.equal(item.evidence.locator.state, "unchanged");
    assert.equal(item.evidence.command.state, "unchanged");
  }
});

test("a referenced source permission change is stale with before and after modes", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  await generatePackage(repo, output);
  await chmod(path.join(repo, "Makefile"), 0o755);

  const report = await inspectSkillStaleness(repo, output);

  assert.equal(report.status, "stale");
  assert.equal(report.revisionChanged, true);
  assert.equal(report.summary.changed, report.summary.total);
  for (const item of report.items) {
    assert.equal(item.classification, "changed");
    assert.equal(item.evidence.sourceFile.contentState, "unchanged");
    assert.equal(item.evidence.sourceFile.modeState, "changed");
    assert.equal(item.evidence.sourceFile.baselineMode, 0o644);
    assert.equal(item.evidence.sourceFile.currentMode, 0o755);
  }
});

test("a newly executable unreviewed script blocks the staleness report", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  const script = path.join(repo, "manual-review.sh");
  await writeFile(script, "#!/bin/sh\nprintf safe\n", { encoding: "utf8", mode: 0o644 });
  await generatePackage(repo, output);
  await chmod(script, 0o755);

  const report = await inspectSkillStaleness(repo, output);

  assert.equal(report.status, "blocked");
  assert.ok(report.issues.some((item) => item.id === "current-security-unreviewed-executable"));
});

test("deleting a referenced source is missing and blocks use of the Skill", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  await generatePackage(repo, output);
  await rm(path.join(repo, "Makefile"));

  const report = await inspectSkillStaleness(repo, output);

  assert.equal(report.status, "blocked");
  assert.equal(report.summary.missing, report.summary.total);
  assert.equal(report.summary.blockingItems, report.summary.total);
  assert.ok(report.items.every((item) => item.classification === "missing"));
  assert.ok(report.items.every((item) => item.evidence.sourceFile.currentHash === null));
  assert.ok(report.items.every((item) => item.evidence.sourceFile.state === "missing"));
});

test("a new verified command in the same category supersedes the removed command", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  await generatePackage(repo, output);
  const makefile = path.join(repo, "Makefile");
  const original = await readFile(makefile, "utf8");
  await writeFile(makefile, original.replace("test:\n\tpython -m pytest", "integration-test:\n\tpython -m pytest"), "utf8");

  const report = await inspectSkillStaleness(repo, output);
  const testWorkflow = report.items.find((item) => item.baseline.command === "make test");

  assert.equal(report.status, "stale");
  assert.equal(testWorkflow.classification, "superseded");
  assert.equal(testWorkflow.current.command, "make integration-test");
  assert.equal(testWorkflow.current.verified, true);
  assert.equal(testWorkflow.evidence.command.state, "changed");
  assert.equal(testWorkflow.evidence.locator.state, "changed");
  assert.notEqual(testWorkflow.current.source.contentHash, testWorkflow.baseline.source.contentHash);
  assert.ok(testWorkflow.alternatives.some((item) => item.command === "make test" && item.verified === false));
});

test("a command that remains only in documentation becomes unverified and blocked", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  await generatePackage(repo, output);
  const makefile = path.join(repo, "Makefile");
  const original = await readFile(makefile, "utf8");
  await writeFile(makefile, original.replace("test:\n\tpython -m pytest\n\n", ""), "utf8");

  const report = await inspectSkillStaleness(repo, output);
  const testWorkflow = report.items.find((item) => item.baseline.command === "make test");

  assert.equal(report.status, "blocked");
  assert.equal(testWorkflow.classification, "unverified");
  assert.equal(testWorkflow.current.command, "make test");
  assert.equal(testWorkflow.current.verified, false);
  assert.equal(testWorkflow.evidence.verification.currentVerified, false);
});

test("new conflicting commands block the affected category with both sources", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  await generatePackage(repo, output);
  await append(path.join(repo, "Makefile"), "\nunit-test:\n\tpython -m pytest tests/unit\n");

  const report = await inspectSkillStaleness(repo, output);
  const testWorkflow = report.items.find((item) => item.baseline.command === "make test");

  assert.equal(report.status, "blocked");
  assert.equal(testWorkflow.classification, "conflicted");
  assert.deepEqual(
    new Set(testWorkflow.conflict.commands.map((item) => item.command)),
    new Set(["make test", "make unit-test"])
  );
  assert.ok(testWorkflow.conflict.commands.every((item) => item.sources[0].contentHash));
});

test("local diff fails closed when the baseline repository identity path is missing or invalid", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  await generatePackage(repo, output);
  const analysis = await inspectRepository(repo);
  const sourceMap = JSON.parse(await readFile(path.join(output, "references", "source-map.json"), "utf8"));

  for (const invalidPath of [undefined, "", "relative/repository"] ) {
    const tampered = structuredClone(sourceMap);
    if (invalidPath === undefined) delete tampered.repository.path;
    else tampered.repository.path = invalidPath;
    const report = buildStalenessReport(tampered, analysis);
    assert.equal(report.status, "blocked");
    assert.ok(report.issues.some((issue) => issue.id === "repository-path-mismatch"));
  }
});
