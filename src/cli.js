#!/usr/bin/env node
import { generatePackage, inspectRepository, publicInspection, validatePackage } from "./compiler.js";
import { inspectSkillStaleness, writeStalenessReport } from "./diff.js";
import { writeValidationReport } from "./reports.js";
import { startServer } from "./server.js";

function help() {
  return `Repo2Skill v0.3.0 — local, static repository-to-Skill compiler

Usage:
  node src/cli.js inspect <repo-path-or-public-github-url> [--cache <directory>]
  node src/cli.js generate <source> --output <new-directory> [--target generic|codex|claude|copilot] [--exclude <candidate-id,...>] [--cache <directory>]
  node src/cli.js validate <source> --skill <skill-directory> [--cache <directory>] [--no-write]
  node src/cli.js diff <source> --skill <skill-directory> [--cache <directory>] [--no-write]
  node src/cli.js serve [--port 4173]

Safety:
  Input must be a local Git repository root or strict public github.com HTTPS URL.
  Public repositories use an isolated, credential-free cache. Repository code is never run.
  Output must be outside the repository and an existing directory is never overwritten.
`;
}

const commandOptions = Object.freeze({
  inspect: Object.freeze({ values: Object.freeze(["--cache"]), booleans: Object.freeze([]), positionals: 1 }),
  generate: Object.freeze({
    values: Object.freeze(["--output", "--target", "--exclude", "--cache"]),
    booleans: Object.freeze([]),
    positionals: 1
  }),
  validate: Object.freeze({
    values: Object.freeze(["--skill", "--cache"]),
    booleans: Object.freeze(["--no-write"]),
    positionals: 1
  }),
  diff: Object.freeze({
    values: Object.freeze(["--skill", "--cache"]),
    booleans: Object.freeze(["--no-write"]),
    positionals: 1
  }),
  serve: Object.freeze({ values: Object.freeze(["--port"]), booleans: Object.freeze([]), positionals: 0 })
});

function parseCommandArguments(command, tokens) {
  const schema = commandOptions[command];
  if (!schema) throw new Error(`Unknown command: ${command}`);

  const valueOptions = new Set(schema.values);
  const booleanOptions = new Set(schema.booleans);
  const parsedOptions = Object.create(null);
  const positionals = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (!valueOptions.has(token) && !booleanOptions.has(token)) {
      throw new Error(`Unknown option for ${command}: ${token}`);
    }
    if (Object.hasOwn(parsedOptions, token)) {
      throw new Error(`Option ${token} may only be provided once`);
    }
    if (booleanOptions.has(token)) {
      parsedOptions[token] = true;
      continue;
    }

    const value = tokens[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) {
      throw new Error(`Option ${token} requires a value`);
    }
    parsedOptions[token] = value;
    index += 1;
  }

  if (positionals.length > schema.positionals) {
    throw new Error(`Unexpected positional argument for ${command}: ${positionals[schema.positionals]}`);
  }
  if (positionals.length < schema.positionals) {
    throw new Error("A local Git repository path or public GitHub URL is required");
  }

  return { options: parsedOptions, positionals };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) {
    console.log(help());
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    if (args.length > 1) throw new Error(`${command} does not accept additional arguments`);
    console.log(help());
    return;
  }
  const { options, positionals } = parseCommandArguments(command, args.slice(1));
  if (command === "serve") {
    const port = Number(options["--port"] ?? 4173);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
    const { url } = await startServer({ port });
    console.log(`Repo2Skill UI: ${url}`);
    console.log("Loopback only. Repository scripts and commands are never executed.");
    return;
  }
  const [repo] = positionals;
  const cacheRoot = options["--cache"];
  const sourceOptions = cacheRoot ? { cacheRoot } : {};
  if (command === "inspect") {
    const analysis = await inspectRepository(repo, { sourceOptions });
    console.log(JSON.stringify(publicInspection(analysis), null, 2));
    return;
  }
  if (command === "generate") {
    const output = options["--output"];
    if (!output) throw new Error("--output <new-directory> is required");
    const excludedIds = (options["--exclude"] || "").split(",").map((value) => value.trim()).filter(Boolean);
    const target = options["--target"] || "generic";
    const result = await generatePackage(repo, output, { excludedIds, target, sourceOptions });
    console.log(JSON.stringify({ output: result.outputPath, target: result.agent.metadata, validation: result.validation }, null, 2));
    if (result.validation.status === "blocked") process.exitCode = 2;
    return;
  }
  if (command === "validate") {
    const skill = options["--skill"];
    if (!skill) throw new Error("--skill <skill-directory> is required");
    const validation = await validatePackage(repo, skill, { sourceOptions });
    if (!options["--no-write"]) {
      await writeValidationReport(skill, validation);
    }
    console.log(JSON.stringify(validation, null, 2));
    if (validation.status === "blocked") process.exitCode = 2;
    return;
  }
  if (command === "diff") {
    const skill = options["--skill"];
    if (!skill) throw new Error("--skill <skill-directory> is required");
    const report = await inspectSkillStaleness(repo, skill, { sourceOptions });
    if (!options["--no-write"]) await writeStalenessReport(skill, report);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "blocked") process.exitCode = 2;
    else if (report.status === "stale") process.exitCode = 3;
    return;
  }
}

main().catch((error) => {
  console.error(`Repo2Skill error: ${error.message}`);
  process.exitCode = 1;
});
