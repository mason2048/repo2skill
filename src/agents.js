import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const AGENT_TARGETS = Object.freeze(["generic", "codex", "claude", "copilot"]);

export const REQUIRED_SKILL_FILES = Object.freeze([
  "SKILL.md",
  "references/source-map.json",
  "reports/validation.json",
  "reports/security.md",
  "context-package.json"
]);

const TARGET_ALIASES = new Map([
  ["generic", "generic"],
  ["universal", "generic"],
  ["agent-skills", "generic"],
  ["codex", "codex"],
  ["openai-codex", "codex"],
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["copilot", "copilot"],
  ["github-copilot", "copilot"]
]);

const TARGET_DEFINITIONS = Object.freeze({
  generic: Object.freeze({
    displayName: "Generic Agent Skills",
    projectRoot: "$PROJECT_ROOT/.agents/skills",
    userRoot: "$HOME/.agents/skills",
    hostMetadataFiles: Object.freeze([]),
    notes: "Portable Agent Skills layout; confirm the selected host supports the suggested discovery directory."
  }),
  codex: Object.freeze({
    displayName: "OpenAI Codex",
    projectRoot: "$REPO_ROOT/.agents/skills",
    userRoot: "$HOME/.agents/skills",
    hostMetadataFiles: Object.freeze(["agents/openai.yaml"]),
    notes: "Codex reads repository and user skills from .agents/skills and supports optional agents/openai.yaml metadata."
  }),
  claude: Object.freeze({
    displayName: "Claude Code",
    projectRoot: "$PROJECT_ROOT/.claude/skills",
    userRoot: "$HOME/.claude/skills",
    hostMetadataFiles: Object.freeze([]),
    notes: "Claude Code discovers a skill directory containing SKILL.md under .claude/skills."
  }),
  copilot: Object.freeze({
    displayName: "GitHub Copilot",
    projectRoot: "$REPO_ROOT/.github/skills",
    userRoot: "$HOME/.copilot/skills",
    hostMetadataFiles: Object.freeze([]),
    notes: "GitHub Copilot discovers project skills under .github/skills and personal skills under .copilot/skills."
  })
});

const EXTRA_ARTIFACTS = Object.freeze(["agents/target.json", "agents/INSTALL.md"]);

export function normalizeAgentTarget(value = "generic") {
  if (typeof value !== "string") {
    throw new TypeError(`Agent target must be a string. Allowed targets: ${AGENT_TARGETS.join(", ")}`);
  }
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const target = TARGET_ALIASES.get(normalized);
  if (!target) {
    throw new TypeError(`Unsupported agent target "${value}". Allowed targets: ${AGENT_TARGETS.join(", ")}`);
  }
  return target;
}

export function isSupportedAgentTarget(value) {
  try {
    normalizeAgentTarget(value);
    return true;
  } catch {
    return false;
  }
}

function normalizedSkillName(value) {
  const candidate = String(value || "generated-skill").trim();
  const sourcePathLike = /^(?:file:\/\/\/|~[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(candidate);
  const normalized = (sourcePathLike ? "generated-skill" : candidate)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return normalized || "generated-skill";
}

function withoutSensitivePaths(value, fallback, maximum) {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/file:\/\/\/[^\s"'`]+/gi, "[local path]")
    .replace(/\/(?:Users|home)\/[^\s"'`]+/g, "[local path]")
    .replace(/\b[A-Za-z]:\\[^\s"'`]+/g, "[local path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  return cleaned || fallback;
}

function titleFromSkillName(skillName) {
  return skillName.split("-").filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ");
}

function pathFor(root, skillName) {
  return `${root}/${skillName}`;
}

export function getAgentTargetMetadata(targetInput = "generic", metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Agent metadata must be an object");
  }
  const target = normalizeAgentTarget(targetInput);
  const definition = TARGET_DEFINITIONS[target];
  const skillName = normalizedSkillName(metadata.skillName);
  const fallbackDisplayName = titleFromSkillName(skillName);
  const displayName = withoutSensitivePaths(metadata.displayName, fallbackDisplayName, 80);
  const description = withoutSensitivePaths(
    metadata.description,
    "Repository-backed workflow guidance with source mapping and static validation.",
    240
  );
  const targetFiles = [...EXTRA_ARTIFACTS, ...definition.hostMetadataFiles];

  return {
    schemaVersion: "0.1",
    target,
    host: {
      displayName: definition.displayName,
      format: "agent-skill"
    },
    skill: { name: skillName, displayName, description },
    installation: {
      automatic: false,
      projectPath: pathFor(definition.projectRoot, skillName),
      userPath: pathFor(definition.userRoot, skillName),
      notes: definition.notes
    },
    package: {
      canonicalRoot: ".",
      requiredRootFiles: [...REQUIRED_SKILL_FILES],
      targetFiles,
      copyMode: "copy-the-reviewed-package-root"
    },
    safety: {
      writesOutsidePackage: false,
      autoInstalls: false,
      grantsTools: false,
      duplicatesSourceMap: false
    }
  };
}

async function optionalStat(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function validateCanonicalPackage(outputInput) {
  const requested = path.resolve(outputInput);
  const rootStat = await optionalStat(requested);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Agent artifacts require an existing, non-symlink generated Skill directory");
  }
  const outputPath = await realpath(requested);
  for (const relative of REQUIRED_SKILL_FILES) {
    const artifact = await optionalStat(path.join(outputPath, relative));
    if (!artifact?.isFile() || artifact.isSymbolicLink()) {
      throw new Error(`Generated Skill is missing required root file: ${relative}`);
    }
  }
  return outputPath;
}

async function skillNameFromRoot(outputPath) {
  const skill = await readFile(path.join(outputPath, "SKILL.md"), "utf8");
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(skill)?.[1] || "";
  const rawName = /^name:\s*["']?([^\n"']+)["']?\s*$/m.exec(frontmatter)?.[1];
  return normalizedSkillName(rawName);
}

export function agentInstallMarkdown(adapter) {
  return `# ${adapter.host.displayName} target adapter\n\nThis directory is metadata for the canonical Skill package at \`../\`. The root \`SKILL.md\`, \`references/\`, \`reports/\`, and \`context-package.json\` remain the source of truth.\n\n## Suggested locations\n\n- Project: \`${adapter.installation.projectPath}\`\n- User: \`${adapter.installation.userPath}\`\n\nCopy the entire reviewed package root to one of these locations only after checking \`../reports/validation.json\` and \`../reports/security.md\`. Repo2Skill does not install, link, or write to either location automatically.\n\n${adapter.installation.notes}\n`;
}

export function codexOpenaiYaml(adapter, allowImplicitInvocation = true) {
  const quote = (value) => JSON.stringify(value);
  const fallback = "Repository-backed workflows with static validation.";
  const candidate = withoutSensitivePaths(adapter.skill.description, fallback, 64);
  const shortDescription = candidate.length >= 25 ? candidate : fallback;
  return `interface:\n  display_name: ${quote(adapter.skill.displayName)}\n  short_description: ${quote(shortDescription)}\n  default_prompt: ${quote(`Use $${adapter.skill.name} for repository-backed workflow guidance. Review validation and security reports before running commands.`)}\npolicy:\n  allow_implicit_invocation: ${allowImplicitInvocation}\n`;
}

export async function createAgentArtifacts(outputInput, targetInput = "generic", metadata = {}) {
  const target = normalizeAgentTarget(targetInput);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Agent metadata must be an object");
  }
  const outputPath = await validateCanonicalPackage(outputInput);
  const skillName = metadata.skillName || await skillNameFromRoot(outputPath);
  const adapter = getAgentTargetMetadata(target, { ...metadata, skillName });
  const agentsDirectory = path.join(outputPath, "agents");
  const existingDirectory = await optionalStat(agentsDirectory);
  if (existingDirectory?.isSymbolicLink() || (existingDirectory && !existingDirectory.isDirectory())) {
    throw new Error("Refusing to write Agent artifacts through a symlink or non-directory agents path");
  }

  const relativeFiles = adapter.package.targetFiles;
  for (const relative of relativeFiles) {
    if (await optionalStat(path.join(outputPath, relative))) {
      throw new Error(`Agent artifact already exists; no overwrite was performed: ${relative}`);
    }
  }

  if (!existingDirectory) await mkdir(agentsDirectory, { recursive: false });
  const canonicalAgentsDirectory = await realpath(agentsDirectory);
  if (canonicalAgentsDirectory !== path.join(outputPath, "agents")) {
    throw new Error("Refusing to write Agent artifacts outside the generated Skill directory");
  }

  await writeFile(path.join(agentsDirectory, "target.json"), `${JSON.stringify(adapter, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(path.join(agentsDirectory, "INSTALL.md"), agentInstallMarkdown(adapter), { encoding: "utf8", flag: "wx" });
  if (adapter.target === "codex") {
    const allowImplicitInvocation = typeof metadata.allowImplicitInvocation === "boolean" ? metadata.allowImplicitInvocation : true;
    await writeFile(path.join(agentsDirectory, "openai.yaml"), codexOpenaiYaml(adapter, allowImplicitInvocation), { encoding: "utf8", flag: "wx" });
  }

  return {
    outputPath,
    target: adapter.target,
    files: relativeFiles,
    metadata: adapter
  };
}
