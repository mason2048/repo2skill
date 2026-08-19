import { randomUUID } from "node:crypto";
import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

async function optionalStat(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeJsonReport(skillDirectory, filename, report) {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(filename)) throw new TypeError("Report filename is not allowed");
  const requestedRoot = path.resolve(skillDirectory);
  const rootStat = await optionalStat(requestedRoot);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Generated Skill directory must be an existing real directory");
  const root = await realpath(requestedRoot);
  const reports = path.join(root, "reports");
  const reportsStat = await optionalStat(reports);
  if (!reportsStat?.isDirectory() || reportsStat.isSymbolicLink()) throw new Error("Generated Skill reports directory must be an existing real directory");
  if (await realpath(reports) !== reports) throw new Error("Refusing to write reports outside the generated Skill directory");

  const target = path.join(reports, filename);
  const targetStat = await optionalStat(target);
  if (targetStat?.isSymbolicLink() || (targetStat && !targetStat.isFile())) {
    throw new Error(`Refusing to replace a linked or non-file report: ${filename}`);
  }
  const temporary = path.join(reports, `.${filename}-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

export function writeValidationReport(skillDirectory, report) {
  return writeJsonReport(skillDirectory, "validation.json", report);
}
