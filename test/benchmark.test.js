import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { generatePackage, inspectRepository, validatePackage } from "../src/compiler.js";
import { inspectSkillStaleness } from "../src/diff.js";
import { sha256 } from "../src/repository.js";
import { fixtureRepository, git } from "./helpers.js";

const MODULE_COUNT = 80;
const FILES_PER_MODULE = 12;
const EXPECTED_SCANNED_FILES = (MODULE_COUNT * FILES_PER_MODULE) + 9;
const EXPECTED_CANDIDATES = 15;
const REPEAT_COUNT = 3;

// This is deliberately much tighter than the five-minute product objective,
// while leaving enough headroom for a sandbox running all test files in
// parallel. Setup and Git fixture creation are excluded from the measurement.
const ROUND_BUDGET_MS = 12_000;
const REPEATED_PATH_BUDGET_MS = 30_000;

const COMMANDS = Object.freeze([
  ["install", "npm run install"],
  ["test", "npm run test"],
  ["build", "npm run build"],
  ["format", "npm run format"],
  ["lint", "npm run lint"]
]);

function elapsedSince(started) {
  return performance.now() - started;
}

function rounded(milliseconds) {
  return Math.round(milliseconds * 10) / 10;
}

function stableInspectionDigest(analysis) {
  const view = analysis.candidates.map((candidate) => ({
    id: candidate.id,
    command: candidate.command,
    category: candidate.category,
    verified: candidate.verified,
    redacted: candidate.redacted === true,
    source: {
      path: candidate.source.path,
      locator: candidate.source.locator,
      contentHash: candidate.source.contentHash,
      mode: candidate.source.mode
    }
  }));
  return sha256(JSON.stringify(view));
}

async function createMediumRepository(testContext) {
  const fixture = await fixtureRepository("node", testContext);
  const sentinel = path.join(fixture.repo, "REPOSITORY_COMMAND_WAS_EXECUTED");
  const runner = `import { writeFileSync } from "node:fs";\nwriteFileSync("${path.basename(sentinel)}", "unexpected execution\\n");\n`;

  await writeFile(path.join(fixture.repo, "package.json"), `${JSON.stringify({
    name: "repo2skill-medium-benchmark",
    private: true,
    type: "module",
    scripts: Object.fromEntries(COMMANDS.map(([name]) => [name, "node scripts/repository-command.js"]))
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(fixture.repo, "README.md"), `# Medium benchmark repository\n\nVerified maintenance commands:\n\n\`\`\`sh\n${COMMANDS.map(([, command]) => command).join("\n")}\n\`\`\`\n`, "utf8");
  await mkdir(path.join(fixture.repo, "scripts"), { recursive: true });
  await writeFile(path.join(fixture.repo, "scripts", "repository-command.js"), runner, { encoding: "utf8", mode: 0o644 });
  await mkdir(path.join(fixture.repo, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(fixture.repo, ".github", "workflows", "ci.yml"), `name: static benchmark\non: [push]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n${COMMANDS.map(([, command]) => `      - run: ${command}`).join("\n")}\n`, "utf8");
  await writeFile(path.join(fixture.repo, "tsconfig.json"), "{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true }\n}\n", "utf8");
  await writeFile(path.join(fixture.repo, "eslint.config.js"), "export default [];\n", "utf8");
  await writeFile(path.join(fixture.repo, ".prettierrc.json"), "{ \"semi\": true }\n", "utf8");
  await writeFile(path.join(fixture.repo, "Makefile"), ".PHONY: help\nhelp:\n\t@printf 'See README\\n'\n", "utf8");

  for (let moduleIndex = 0; moduleIndex < MODULE_COUNT; moduleIndex += 1) {
    const moduleName = `module-${String(moduleIndex).padStart(3, "0")}`;
    const directory = path.join(fixture.repo, "packages", moduleName);
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: FILES_PER_MODULE }, (_, fileIndex) => {
      const fileName = `source-${String(fileIndex).padStart(2, "0")}.js`;
      const content = `// Deterministic benchmark source: ${moduleName}/${fileName}\nexport const value = ${moduleIndex * FILES_PER_MODULE + fileIndex};\n`;
      return writeFile(path.join(directory, fileName), content, "utf8");
    }));
  }

  git(fixture.repo, ["add", "."]);
  git(fixture.repo, ["commit", "--quiet", "-m", "medium deterministic benchmark fixture"]);
  return { ...fixture, sentinel };
}

test("medium repository inspect/generate/validate/diff remains stable well below five minutes", { timeout: 45_000 }, async (t) => {
  const { sandbox, repo, sentinel } = await createMediumRepository(t);
  const stableResults = [];
  let repeatedPathMs = 0;

  for (let round = 1; round <= REPEAT_COUNT; round += 1) {
    const output = path.join(sandbox, `generated-skill-${round}`);
    const phaseMs = {};
    const roundStarted = performance.now();

    let started = performance.now();
    const analysis = await inspectRepository(repo);
    phaseMs.inspect = elapsedSince(started);

    started = performance.now();
    const generated = await generatePackage(repo, output, { target: "generic", analysis });
    phaseMs.generate = elapsedSince(started);

    started = performance.now();
    const validation = await validatePackage(repo, output);
    phaseMs.validate = elapsedSince(started);

    started = performance.now();
    const difference = await inspectSkillStaleness(repo, output);
    phaseMs.diff = elapsedSince(started);
    phaseMs.total = elapsedSince(roundStarted);
    repeatedPathMs += phaseMs.total;

    const sourceMap = await readFile(path.join(output, "references", "source-map.json"), "utf8");
    const stable = {
      revision: analysis.scan.revision,
      snapshotHash: analysis.scan.snapshotHash,
      scannedFiles: analysis.scan.scannedFiles,
      candidateDigest: stableInspectionDigest(analysis),
      candidateCount: analysis.candidates.length,
      workflowIds: analysis.workflows.map((workflow) => workflow.id),
      sourceMapHash: sha256(sourceMap),
      generatedStatus: generated.validation.status,
      validationStatus: validation.status,
      validationScore: validation.score,
      diffStatus: difference.status,
      diffSummary: difference.summary,
      classifications: difference.items.map((item) => item.classification)
    };
    stableResults.push(stable);

    assert.equal(analysis.scan.scannedFiles, EXPECTED_SCANNED_FILES, "fixture size must remain reproducible");
    assert.equal(analysis.candidates.length, EXPECTED_CANDIDATES, "candidate evidence set must remain reproducible");
    assert.equal(analysis.workflows.length, COMMANDS.length);
    assert.equal(analysis.securityFindings.length, 0);
    assert.equal(generated.validation.status, "passed");
    assert.equal(validation.status, "passed");
    assert.equal(validation.score, 100);
    assert.equal(difference.status, "current");
    assert.equal(difference.summary.total, COMMANDS.length);
    assert.equal(difference.summary.unchanged, COMMANDS.length);
    assert.ok(difference.items.every((item) => item.classification === "unchanged"));
    await assert.rejects(access(sentinel), (error) => error?.code === "ENOENT", "static analysis must never execute a repository command");
    assert.ok(phaseMs.total <= ROUND_BUDGET_MS, `round ${round} took ${rounded(phaseMs.total)} ms; budget is ${ROUND_BUDGET_MS} ms`);

    t.diagnostic(`medium benchmark round ${round}/${REPEAT_COUNT}: ${JSON.stringify(Object.fromEntries(Object.entries(phaseMs).map(([name, value]) => [name, rounded(value)])))} ms; files=${analysis.scan.scannedFiles}; candidates=${analysis.candidates.length}; workflows=${analysis.workflows.length}`);
  }

  for (const result of stableResults.slice(1)) {
    assert.deepEqual(result, stableResults[0], "revision, candidates, evidence hashes, validation and diff results must be repeat-stable");
  }
  assert.ok(repeatedPathMs <= REPEATED_PATH_BUDGET_MS, `three repeated paths took ${rounded(repeatedPathMs)} ms; budget is ${REPEATED_PATH_BUDGET_MS} ms`);
  t.diagnostic(`medium benchmark repeated total: ${rounded(repeatedPathMs)} ms / ${REPEATED_PATH_BUDGET_MS} ms budget (five-minute objective: 300000 ms)`);
});
