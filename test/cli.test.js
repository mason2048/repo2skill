import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { append, fixtureRepository } from "./helpers.js";

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.js");

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
}

function assertCliArgumentError(args, pattern) {
  const result = runCli(args);
  assert.equal(result.status, 1, `expected CLI failure for: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, "");
}

test("CLI inspect exposes locked scope and preview candidates", async (t) => {
  const { repo } = await fixtureRepository("node", t);
  const result = spawnSync(process.execPath, [CLI, "inspect", repo], { encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.repository.repository, await realpath(repo));
  assert.match(preview.repository.revision, /^[a-f0-9]{40}$/);
  assert.ok(preview.repository.excludedDirectories.includes(".git"));
  assert.ok(preview.candidates.length > 0);
  assert.match(preview.note, /No repository command or script was executed/);
});

test("CLI generate followed by validate succeeds for a safe fixture", async (t) => {
  const { repo, output } = await fixtureRepository("java", t);
  const generated = spawnSync(process.execPath, [CLI, "generate", repo, "--output", output], { encoding: "utf8", shell: false });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const validated = spawnSync(process.execPath, [CLI, "validate", repo, "--skill", output, "--no-write"], { encoding: "utf8", shell: false });
  assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  assert.equal(JSON.parse(validated.stdout).status, "passed");
});

test("CLI generation, validation, and diff share the minimum-workflow blocker and exit code", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  await writeFile(path.join(repo, "Makefile"), [
    "install:",
    "\tpython -m pip install -e .",
    "",
    "test:",
    "\tpython -m pytest",
    ""
  ].join("\n"), "utf8");

  const generated = runCli(["generate", repo, "--output", output]);
  assert.equal(generated.status, 2, generated.stderr || generated.stdout);
  assert.ok(JSON.parse(generated.stdout).validation.blockers.some((item) => item.id === "insufficient-workflows"));

  const validated = runCli(["validate", repo, "--skill", output, "--no-write"]);
  assert.equal(validated.status, 2, validated.stderr || validated.stdout);
  assert.ok(JSON.parse(validated.stdout).blockers.some((item) => item.id === "insufficient-workflows"));

  const compared = runCli(["diff", repo, "--skill", output, "--no-write"]);
  assert.equal(compared.status, 2, compared.stderr || compared.stdout);
  assert.ok(JSON.parse(compared.stdout).issues.some((item) => item.id === "insufficient-workflows"));
});

test("CLI target adapter and revision diff are integrated", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  const generated = spawnSync(process.execPath, [CLI, "generate", repo, "--output", output, "--target", "claude"], { encoding: "utf8", shell: false });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  assert.equal(JSON.parse(generated.stdout).target.target, "claude");
  const compared = spawnSync(process.execPath, [CLI, "diff", repo, "--skill", output], { encoding: "utf8", shell: false });
  assert.equal(compared.status, 0, compared.stderr || compared.stdout);
  assert.equal(JSON.parse(compared.stdout).status, "current");
});

test("CLI revision diff uses a distinct stale exit code", async (t) => {
  const { repo, output } = await fixtureRepository("python", t);
  const generated = spawnSync(process.execPath, [CLI, "generate", repo, "--output", output], { encoding: "utf8", shell: false });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  await append(path.join(repo, "Makefile"), "\n# new revision evidence\n");
  const compared = spawnSync(process.execPath, [CLI, "diff", repo, "--skill", output, "--no-write"], { encoding: "utf8", shell: false });
  assert.equal(compared.status, 3, compared.stderr || compared.stdout);
  assert.equal(JSON.parse(compared.stdout).status, "stale");
});

test("CLI validation report cannot follow a symlink outside the generated package", async (t) => {
  const { repo, output, sandbox } = await fixtureRepository("java", t);
  const generated = spawnSync(process.execPath, [CLI, "generate", repo, "--output", output], { encoding: "utf8", shell: false });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  const victim = path.join(sandbox, "victim.txt");
  await writeFile(victim, "owner data\n", "utf8");
  const validation = path.join(output, "reports", "validation.json");
  await rm(validation);
  await symlink(victim, validation);

  const validated = spawnSync(process.execPath, [CLI, "validate", repo, "--skill", output], { encoding: "utf8", shell: false });
  assert.equal(validated.status, 1);
  assert.match(validated.stderr, /linked or non-file report/);
  assert.equal(await readFile(victim, "utf8"), "owner data\n");
});

test("CLI rejects unknown options for every command before doing work", () => {
  for (const args of [
    ["inspect", "/not-used", "--json"],
    ["generate", "/not-used", "--output", "/not-created", "--out", "/also-not-created"],
    ["validate", "/not-used", "--skill", "/not-used", "--cache-dir", "/not-used"],
    ["diff", "/not-used", "--skill", "/not-used", "--wat"],
    ["serve", "--listen", "127.0.0.1"]
  ]) {
    assertCliArgumentError(args, /Unknown option/);
  }
});

test("CLI rejects missing and empty option values", () => {
  for (const [args, optionName] of [
    [["inspect", "/not-used", "--cache"], "--cache"],
    [["generate", "/not-used", "--output"], "--output"],
    [["generate", "/not-used", "--output", "--target", "codex"], "--output"],
    [["generate", "/not-used", "--output", ""], "--output"],
    [["generate", "/not-used", "--output", "/not-created", "--target"], "--target"],
    [["generate", "/not-used", "--output", "/not-created", "--exclude"], "--exclude"],
    [["generate", "/not-used", "--output", "/not-created", "--cache"], "--cache"],
    [["validate", "/not-used", "--skill"], "--skill"],
    [["validate", "/not-used", "--skill", "/not-used", "--cache"], "--cache"],
    [["diff", "/not-used", "--skill"], "--skill"],
    [["diff", "/not-used", "--skill", "/not-used", "--cache"], "--cache"],
    [["serve", "--port"], "--port"]
  ]) {
    assertCliArgumentError(args, new RegExp(`Option ${optionName} requires a value`));
  }
});

test("CLI rejects duplicate value and boolean options", () => {
  for (const [command, args, optionName] of [
    ["inspect", ["/not-used", "--cache", "/one", "--cache", "/two"], "--cache"],
    ["generate", ["/not-used", "--output", "/one", "--output", "/two"], "--output"],
    ["generate", ["/not-used", "--output", "/one", "--target", "codex", "--target", "claude"], "--target"],
    ["generate", ["/not-used", "--output", "/one", "--exclude", "a", "--exclude", "b"], "--exclude"],
    ["generate", ["/not-used", "--output", "/one", "--cache", "/one", "--cache", "/two"], "--cache"],
    ["validate", ["/not-used", "--skill", "/one", "--skill", "/two"], "--skill"],
    ["validate", ["/not-used", "--skill", "/one", "--cache", "/one", "--cache", "/two"], "--cache"],
    ["validate", ["/not-used", "--skill", "/one", "--no-write", "--no-write"], "--no-write"],
    ["diff", ["/not-used", "--skill", "/one", "--skill", "/two"], "--skill"],
    ["diff", ["/not-used", "--skill", "/one", "--cache", "/one", "--cache", "/two"], "--cache"],
    ["diff", ["/not-used", "--skill", "/one", "--no-write", "--no-write"], "--no-write"],
    ["serve", ["--port", "4173", "--port", "4174"], "--port"]
  ]) {
    assertCliArgumentError([command, ...args], new RegExp(`Option ${optionName} may only be provided once`));
  }
});

test("CLI rejects options used with the wrong command and extra positionals", () => {
  for (const args of [
    ["inspect", "/not-used", "--skill", "/not-used"],
    ["generate", "/not-used", "--output", "/not-created", "--no-write"],
    ["validate", "/not-used", "--skill", "/not-used", "--target", "codex"],
    ["diff", "/not-used", "--skill", "/not-used", "--output", "/not-created"],
    ["serve", "/unexpected"]
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option|Unexpected positional argument/);
  }
});

test("CLI rejects extra positional arguments for every command", () => {
  for (const args of [
    ["inspect", "/not-used", "/extra"],
    ["generate", "/not-used", "/extra", "--output", "/not-created"],
    ["validate", "/not-used", "/extra", "--skill", "/not-used"],
    ["diff", "/not-used", "/extra", "--skill", "/not-used"],
    ["serve", "/extra"]
  ]) {
    assertCliArgumentError(args, /Unexpected positional argument/);
  }
});

test("CLI help rejects trailing arguments instead of silently ignoring them", () => {
  assertCliArgumentError(["--help", "--json"], /does not accept additional arguments/);
});
