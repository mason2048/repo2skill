import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_TARGETS,
  REQUIRED_SKILL_FILES,
  createAgentArtifacts,
  getAgentTargetMetadata,
  isSupportedAgentTarget,
  normalizeAgentTarget
} from "../src/agents.js";

async function missing(filePath) {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function generatedPackage(testContext, suffix) {
  const sandbox = await mkdtemp(path.join(tmpdir(), `repo2skill-agent-${suffix}-`));
  testContext.after(() => rm(sandbox, { recursive: true, force: true }));
  const output = path.join(sandbox, "generated-skill");
  await mkdir(path.join(output, "references"), { recursive: true });
  await mkdir(path.join(output, "reports"), { recursive: true });
  const contents = new Map([
    ["SKILL.md", "---\nname: repo2skill-fixture\ndescription: Fixture workflow\n---\n\n# Fixture\n"],
    ["references/source-map.json", "{\"commands\":[]}\n"],
    ["reports/validation.json", "{\"status\":\"passed\"}\n"],
    ["reports/security.md", "# Security\n"],
    ["context-package.json", "{\"schemaVersion\":\"0.1\"}\n"]
  ]);
  for (const [relative, content] of contents) {
    await writeFile(path.join(output, relative), content, "utf8");
  }
  return { sandbox, output, contents };
}

test("agent target names normalize to the four canonical values", () => {
  assert.deepEqual(AGENT_TARGETS, ["generic", "codex", "claude", "copilot"]);
  assert.equal(normalizeAgentTarget(), "generic");
  assert.equal(normalizeAgentTarget(" CODEX "), "codex");
  assert.equal(normalizeAgentTarget("Claude_Code"), "claude");
  assert.equal(normalizeAgentTarget("github copilot"), "copilot");
  assert.equal(normalizeAgentTarget("agent-skills"), "generic");
  assert.equal(isSupportedAgentTarget("Claude Code"), true);
  assert.equal(isSupportedAgentTarget("unknown"), false);
  assert.equal(getAgentTargetMetadata("generic", { skillName: "/Users/example/private-repository" }).skill.name, "generated-skill");
  assert.throws(() => getAgentTargetMetadata("generic", null), /metadata must be an object/);
});

const EXPECTED_PATHS = {
  generic: ["$PROJECT_ROOT/.agents/skills/repo2skill-fixture", "$HOME/.agents/skills/repo2skill-fixture"],
  codex: ["$REPO_ROOT/.agents/skills/repo2skill-fixture", "$HOME/.agents/skills/repo2skill-fixture"],
  claude: ["$PROJECT_ROOT/.claude/skills/repo2skill-fixture", "$HOME/.claude/skills/repo2skill-fixture"],
  copilot: ["$REPO_ROOT/.github/skills/repo2skill-fixture", "$HOME/.copilot/skills/repo2skill-fixture"]
};

for (const target of AGENT_TARGETS) {
  test(`${target} adapter preserves the canonical package and emits a manual-install layout`, async (t) => {
    const { output, contents } = await generatedPackage(t, target);
    const sensitivePath = "/Users/example/private/repository";
    const result = await createAgentArtifacts(output, target, {
      displayName: `Fixture from ${sensitivePath}`,
      description: `Workflow extracted from file://${sensitivePath}/README.md`,
      repositoryPath: sensitivePath
    });

    assert.equal(result.target, target);
    assert.ok(result.files.every((relative) => relative.startsWith("agents/")));
    for (const [relative, original] of contents) {
      assert.equal(await readFile(path.join(output, relative), "utf8"), original, `${relative} must remain unchanged`);
    }

    const targetJson = await readFile(path.join(output, "agents", "target.json"), "utf8");
    const adapter = JSON.parse(targetJson);
    assert.equal(adapter.target, target);
    assert.equal(adapter.installation.automatic, false);
    assert.equal(adapter.installation.projectPath, EXPECTED_PATHS[target][0]);
    assert.equal(adapter.installation.userPath, EXPECTED_PATHS[target][1]);
    assert.deepEqual(adapter.package.requiredRootFiles, REQUIRED_SKILL_FILES);
    assert.equal(adapter.package.canonicalRoot, ".");
    assert.equal(adapter.safety.writesOutsidePackage, false);
    assert.equal(adapter.safety.autoInstalls, false);
    assert.ok(!targetJson.includes(sensitivePath));

    const install = await readFile(path.join(output, "agents", "INSTALL.md"), "utf8");
    assert.match(install, /does not install, link, or write/i);
    assert.ok(install.includes(EXPECTED_PATHS[target][0]));
    assert.ok(!install.includes(sensitivePath));

    const codexFile = path.join(output, "agents", "openai.yaml");
    if (target === "codex") {
      const yaml = await readFile(codexFile, "utf8");
      assert.match(yaml, /^interface:/m);
      assert.match(yaml, /^policy:/m);
      assert.match(yaml, /allow_implicit_invocation: true/);
      assert.ok(!yaml.includes("allowed-tools"));
      assert.ok(!yaml.includes(sensitivePath));
      const encodedDescription = /^\s*short_description:\s*(.+)$/m.exec(yaml)?.[1];
      const shortDescription = JSON.parse(encodedDescription);
      assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64);
    } else {
      assert.equal(await missing(codexFile), true);
    }
  });
}

test("unknown targets are rejected before any adapter files are created", async (t) => {
  const { output } = await generatedPackage(t, "unknown");
  await assert.rejects(createAgentArtifacts(output, "cursor"), /Allowed targets: generic, codex, claude, copilot/);
  assert.equal(await missing(path.join(output, "agents")), true);
  assert.throws(() => getAgentTargetMetadata(42), /must be a string/);
});

test("adapter never writes suggested global directories", async (t) => {
  const { sandbox, output } = await generatedPackage(t, "no-global-write");
  await createAgentArtifacts(output, "copilot");
  for (const relative of [".agents", ".claude", ".copilot", ".github"]) {
    assert.equal(await missing(path.join(sandbox, relative)), true, `${relative} must remain only a suggestion`);
  }
});

test("required root files must exist before adapting", async (t) => {
  const { output } = await generatedPackage(t, "missing-root");
  await rm(path.join(output, "reports", "security.md"));
  await assert.rejects(createAgentArtifacts(output, "generic"), /missing required root file: reports\/security.md/);
  assert.equal(await missing(path.join(output, "agents")), true);
});

test("an agents symlink cannot redirect writes outside the package", async (t) => {
  const { sandbox, output } = await generatedPackage(t, "symlink");
  const outside = path.join(sandbox, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(output, "agents"));
  await assert.rejects(createAgentArtifacts(output, "codex"), /Refusing to write Agent artifacts through a symlink/);
  assert.equal(await missing(path.join(outside, "target.json")), true);
  assert.equal(await missing(path.join(outside, "openai.yaml")), true);
});

test("existing adapter artifacts are never overwritten", async (t) => {
  const { output } = await generatedPackage(t, "no-overwrite");
  await mkdir(path.join(output, "agents"));
  await writeFile(path.join(output, "agents", "target.json"), "owner-data\n", "utf8");
  await assert.rejects(createAgentArtifacts(output, "claude"), /no overwrite was performed/);
  assert.equal(await readFile(path.join(output, "agents", "target.json"), "utf8"), "owner-data\n");
});

test("an existing empty agents directory is reused without touching root files", async (t) => {
  const { output } = await generatedPackage(t, "existing-agents-directory");
  await mkdir(path.join(output, "agents"));
  const result = await createAgentArtifacts(output, "generic");
  assert.deepEqual(result.files, ["agents/target.json", "agents/INSTALL.md"]);
  assert.equal(JSON.parse(await readFile(path.join(output, "agents", "target.json"), "utf8")).target, "generic");
});

test("Codex short_description is normalized to the required 25-64 character range", async (t) => {
  const { output } = await generatedPackage(t, "codex-description-length");
  await createAgentArtifacts(output, "codex", { description: "short" });
  const yaml = await readFile(path.join(output, "agents", "openai.yaml"), "utf8");
  const shortDescription = JSON.parse(/^\s*short_description:\s*(.+)$/m.exec(yaml)[1]);
  assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64);
});
