import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectRepository } from "./compiler.js";
import { writeJsonReport } from "./reports.js";
import { fileMap } from "./repository.js";

const CLASSIFICATIONS = [
  "unchanged",
  "changed",
  "missing",
  "unverified",
  "conflicted",
  "superseded"
];

function canonicalCommand(command) {
  return typeof command === "string"
    ? command.trim().replace(/\s+/g, " ").replace(/^npm test$/, "npm run test")
    : "";
}

function sourceView(source) {
  if (!source || typeof source !== "object") return null;
  return {
    path: typeof source.path === "string" ? source.path : null,
    uri: typeof source.uri === "string" ? source.uri : null,
    revision: typeof source.revision === "string" ? source.revision : null,
    locator: typeof source.locator === "string" ? source.locator : null,
    lineStart: Number.isInteger(source.lineStart) ? source.lineStart : null,
    lineEnd: Number.isInteger(source.lineEnd) ? source.lineEnd : null,
    contentHash: typeof source.contentHash === "string" ? source.contentHash : null,
    mode: Number.isInteger(source.mode) ? source.mode : null
  };
}

function normalizedMode(file) {
  return file ? file.mode & 0o777 : null;
}

function sourceMatches(entry, currentFile) {
  if (!currentFile || currentFile.hash !== entry.source?.contentHash) return false;
  return !Number.isInteger(entry.source?.mode) || normalizedMode(currentFile) === entry.source.mode;
}

function candidateView(candidate) {
  if (!candidate) return null;
  return {
    candidateId: candidate.id || null,
    workflowId: candidate.workflowId || null,
    category: candidate.category || null,
    command: candidate.command || null,
    canonicalCommand: canonicalCommand(candidate.command),
    verified: candidate.verified === true,
    verification: candidate.verification || null,
    evidenceKind: candidate.evidenceKind || null,
    source: sourceView(candidate.source)
  };
}

function stableCandidateSort(left, right) {
  return canonicalCommand(left.command).localeCompare(canonicalCommand(right.command))
    || String(left.source?.path || "").localeCompare(String(right.source?.path || ""))
    || String(left.source?.locator || "").localeCompare(String(right.source?.locator || ""));
}

function candidateKey(candidate) {
  return [
    canonicalCommand(candidate?.command),
    candidate?.source?.path || "",
    candidate?.source?.locator || "",
    candidate?.verified === true ? "verified" : "unverified"
  ].join("\0");
}

function uniqueCandidates(candidates) {
  const unique = new Map();
  for (const candidate of [...candidates].sort(stableCandidateSort)) {
    const key = candidateKey(candidate);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function isCompleteBaseline(entry) {
  return Boolean(
    entry
    && typeof entry.category === "string"
    && canonicalCommand(entry.command)
    && entry.verified === true
    && typeof entry.source?.path === "string"
    && typeof entry.source?.locator === "string"
    && typeof entry.source?.revision === "string"
    && typeof entry.source?.contentHash === "string"
  );
}

function sourceFileState(entry, currentFile) {
  if (!entry.source?.path || !entry.source?.contentHash) return "unverified";
  if (!currentFile) return "missing";
  return sourceMatches(entry, currentFile) ? "unchanged" : "changed";
}

function comparisonState(baseline, current, missingState = "unverified") {
  if (baseline == null || baseline === "") return "unverified";
  if (current == null || current === "") return missingState;
  return baseline === current ? "unchanged" : "changed";
}

function reasonFor(classification, entry, selected, currentFile) {
  const pathName = entry.source?.path || "unknown source";
  switch (classification) {
    case "unchanged":
      return "The mapped command, source locator, and source file hash still match verified repository evidence.";
    case "changed":
      return currentFile
        ? `The mapped source ${pathName} content, permissions, or verified locator changed; review the current evidence before using this workflow.`
        : `The current evidence for ${pathName} could not be matched exactly.`;
    case "missing":
      return `The mapped source file ${pathName} no longer exists in the current repository snapshot.`;
    case "unverified":
      return selected
        ? `The command ${entry.command || "(missing command)"} is present only as unverified current evidence.`
        : "The baseline mapping or its current command evidence is incomplete and cannot be verified statically.";
    case "conflicted":
      return `Multiple verified ${entry.category || "unknown"} commands now conflict; Repo2Skill did not choose one.`;
    case "superseded":
      return `The mapped command ${entry.command} is no longer verified and a different verified ${entry.category} command is available.`;
    default:
      return "The mapping could not be classified.";
  }
}

function revisionView(repository, fallbackPath = null) {
  return {
    repository: repository?.path || repository?.repoPath || fallbackPath,
    inputKind: repository?.inputKind || repository?.kind || null,
    canonicalUrl: repository?.canonicalUrl || null,
    revision: repository?.revision || null,
    commit: repository?.commit || null,
    dirty: typeof repository?.dirty === "boolean" ? repository.dirty : null,
    snapshotHash: repository?.snapshotHash || null
  };
}

function classifyEntry(entry, analysis, files) {
  const baselineCommand = canonicalCommand(entry.command);
  const currentFile = entry.source?.path ? files.get(entry.source.path) : null;
  const candidates = uniqueCandidates(
    (analysis.candidates || []).filter((candidate) => candidate.category === entry.category)
  );
  const verified = candidates.filter((candidate) => candidate.verified === true);
  const conflict = (analysis.conflicts || []).find((item) => item.category === entry.category) || null;
  const exactVerified = verified.find((candidate) => (
    canonicalCommand(candidate.command) === baselineCommand
    && candidate.source?.path === entry.source?.path
    && candidate.source?.locator === entry.source?.locator
  ));
  const sameCommandVerified = verified.find((candidate) => canonicalCommand(candidate.command) === baselineCommand);
  const selectedWorkflow = (analysis.workflows || []).find((candidate) => (
    candidate.category === entry.category
    && canonicalCommand(candidate.command) !== baselineCommand
  ));
  const replacements = verified.filter((candidate) => canonicalCommand(candidate.command) !== baselineCommand);
  const replacement = selectedWorkflow || replacements[0] || null;
  const sameCommandUnverified = candidates.find((candidate) => (
    candidate.verified !== true && canonicalCommand(candidate.command) === baselineCommand
  ));

  let classification;
  let selected = null;
  if (entry.source?.path && !currentFile) {
    classification = "missing";
    selected = replacement || sameCommandVerified || sameCommandUnverified || null;
  } else if (!isCompleteBaseline(entry)) {
    classification = "unverified";
    selected = exactVerified || sameCommandVerified || sameCommandUnverified || replacement || null;
  } else if (conflict) {
    classification = "conflicted";
    selected = exactVerified || sameCommandVerified || replacement || sameCommandUnverified || null;
  } else if (exactVerified) {
    classification = sourceMatches(entry, currentFile) ? "unchanged" : "changed";
    selected = exactVerified;
  } else if (sameCommandVerified) {
    classification = "changed";
    selected = sameCommandVerified;
  } else if (replacement) {
    classification = "superseded";
    selected = replacement;
  } else if (sameCommandUnverified) {
    classification = "unverified";
    selected = sameCommandUnverified;
  } else if (currentFile && currentFile.hash !== entry.source.contentHash) {
    classification = "changed";
  } else {
    classification = "unverified";
  }

  const selectedView = candidateView(selected);
  const fileState = sourceFileState(entry, currentFile);
  const missingComparison = classification === "missing" ? "missing" : "unverified";
  return {
    workflowId: entry.workflowId || null,
    candidateId: entry.candidateId || null,
    category: entry.category || null,
    classification,
    blocking: ["missing", "unverified", "conflicted"].includes(classification),
    reason: reasonFor(classification, entry, selected, currentFile),
    baseline: {
      command: entry.command || null,
      canonicalCommand: baselineCommand || null,
      verified: entry.verified === true,
      verification: entry.verification || null,
      source: sourceView(entry.source)
    },
    current: selectedView,
    evidence: {
      sourceFile: {
        state: fileState,
        path: entry.source?.path || null,
        baselineHash: entry.source?.contentHash || null,
        currentHash: currentFile?.hash || null,
        contentState: comparisonState(entry.source?.contentHash, currentFile?.hash, classification === "missing" ? "missing" : "unverified"),
        baselineMode: Number.isInteger(entry.source?.mode) ? entry.source.mode : null,
        currentMode: normalizedMode(currentFile),
        modeState: Number.isInteger(entry.source?.mode)
          ? comparisonState(entry.source.mode, normalizedMode(currentFile), classification === "missing" ? "missing" : "unverified")
          : "unverified"
      },
      locator: {
        state: comparisonState(entry.source?.locator, selectedView?.source?.locator, missingComparison),
        baseline: entry.source?.locator || null,
        current: selectedView?.source?.locator || null
      },
      command: {
        state: comparisonState(baselineCommand, selectedView?.canonicalCommand, missingComparison),
        baseline: entry.command || null,
        current: selectedView?.command || null
      },
      verification: {
        baselineVerified: entry.verified === true,
        currentVerified: selectedView?.verified === true
      }
    },
    alternatives: uniqueCandidates(
      candidates.filter((candidate) => !selected || candidateKey(candidate) !== candidateKey(selected))
    ).map(candidateView),
    conflict: conflict
      ? {
          category: conflict.category,
          message: conflict.message,
          commands: (conflict.commands || []).map((command) => ({
            command: command.command,
            sources: (command.sources || []).map(sourceView)
          }))
        }
      : null
  };
}

/**
 * Compare an existing generated Skill source map with a current static repository
 * inspection. This function performs no filesystem or Git operations itself.
 */
export function buildStalenessReport(sourceMap, analysis) {
  if (!sourceMap || typeof sourceMap !== "object" || !Array.isArray(sourceMap.commands)) {
    throw new TypeError("A parsed references/source-map.json with a commands array is required");
  }
  if (!analysis?.lock?.files || !Array.isArray(analysis.lock.files)) {
    throw new TypeError("A current Repo2Skill inspection result with lock.files is required");
  }

  const files = fileMap(analysis.lock);
  const items = sourceMap.commands.map((entry) => classifyEntry(entry, analysis, files));
  const summary = Object.fromEntries(CLASSIFICATIONS.map((name) => [name, 0]));
  for (const item of items) summary[item.classification] += 1;
  summary.total = items.length;
  summary.staleItems = summary.changed + summary.superseded;
  summary.blockingItems = summary.missing + summary.unverified + summary.conflicted;

  const issues = [];
  if (!sourceMap.repository?.revision) {
    issues.push({ id: "missing-baseline-revision", severity: "blocker", message: "The source map has no locked baseline revision." });
  }
  if (items.length === 0) {
    issues.push({ id: "missing-baseline-commands", severity: "blocker", message: "The source map has no mapped commands to compare." });
  }
  const baselineKind = sourceMap.repository?.inputKind || null;
  const currentKind = analysis.inputSource?.kind || "local";
  const baselinePath = sourceMap.repository?.path || null;
  const baselineUrl = sourceMap.repository?.canonicalUrl || null;
  const currentUrl = analysis.inputSource?.canonicalUrl || null;
  const validBaselinePath = typeof baselinePath === "string" && baselinePath.length > 0
    && path.isAbsolute(baselinePath) && path.normalize(baselinePath) === baselinePath;
  const identityMismatch = baselineKind !== currentKind
    || !validBaselinePath
    || (currentKind === "github"
      ? typeof baselineUrl !== "string" || !baselineUrl || baselineUrl !== currentUrl
      : baselineUrl !== null || path.resolve(baselinePath || path.sep) !== path.resolve(analysis.lock.repoPath));
  if (identityMismatch) {
    issues.push({
      id: "repository-path-mismatch",
      severity: "blocker",
      message: "The generated Skill repository identity is missing, invalid, or belongs to a different source; repository identity cannot be proven by this comparison alone."
    });
  }
  for (const finding of (analysis.securityFindings || []).filter((item) => item.severity === "blocker")) {
    issues.push({
      id: finding.id === "insufficient-workflows" ? finding.id : `current-security-${finding.id}`,
      severity: "blocker",
      message: `Current repository security blocker ${finding.id} at ${finding.path}:${finding.line}.`
    });
  }

  const status = issues.some((issue) => issue.severity === "blocker") || summary.blockingItems > 0
    ? "blocked"
    : summary.staleItems > 0
      ? "stale"
      : "current";
  const baseline = revisionView(sourceMap.repository);
  const current = revisionView({
    ...analysis.lock,
    inputKind: analysis.inputSource?.kind || "local",
    canonicalUrl: currentUrl
  }, analysis.scan?.repository || null);

  return {
    schemaVersion: "0.1",
    kind: "repo2skill-staleness",
    status,
    baseline,
    current,
    revisionChanged: baseline.revision !== current.revision,
    summary,
    items,
    issues,
    boundary: "Static comparison only: repository files and read-only Git metadata were inspected; no checkout, repository command, hook, build, test, or script was run."
  };
}

/**
 * Read a generated Skill source map, inspect the current repository, and return
 * the JSON-serializable object intended for reports/staleness.json.
 */
export async function inspectSkillStaleness(repoInput, skillDirectory, { analysis: suppliedAnalysis, sourceOptions = {} } = {}) {
  const sourceMapPath = path.join(path.resolve(skillDirectory), "references", "source-map.json");
  let sourceMap;
  try {
    sourceMap = JSON.parse(await readFile(sourceMapPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read generated Skill source map at ${sourceMapPath}: ${error.message}`);
  }
  const analysis = suppliedAnalysis || await inspectRepository(repoInput, { sourceOptions });
  return buildStalenessReport(sourceMap, analysis);
}

/**
 * Atomically stores a report in an existing generated package. Symlinked
 * package/report paths are rejected so a UI request cannot redirect writes.
 */
export async function writeStalenessReport(skillDirectory, report) {
  if (!report || report.kind !== "repo2skill-staleness") throw new TypeError("A Repo2Skill staleness report is required");
  return writeJsonReport(skillDirectory, "staleness.json", report);
}
