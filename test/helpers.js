import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

export function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export async function fixtureRepository(name, testContext) {
  const sandbox = await mkdtemp(path.join(tmpdir(), `repo2skill-${name}-`));
  testContext?.after(() => rm(sandbox, { recursive: true, force: true }));
  const repo = path.join(sandbox, "repository");
  await cp(path.join(PROJECT_ROOT, "examples", "fixtures", name), repo, { recursive: true });
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "Repo2Skill Fixture"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "fixture"]);
  return { sandbox, repo, output: path.join(sandbox, "generated-skill") };
}

export async function append(file, content) {
  const previous = await readFile(file, "utf8");
  await writeFile(file, `${previous}${content}`, "utf8");
}
