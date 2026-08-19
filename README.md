# Repo2Skill

[中文](README.zh-CN.md) · [User guide](docs/USER_GUIDE.md) · [Security](SECURITY.md)

Repo2Skill statically compiles a local Git repository or a public GitHub repository into an auditable Agent Skill package. It discovers repository-backed install, test, build, format, lint, and pre-publish workflows, maps every selected command to source evidence, and generates target-specific manual installation guidance.

Version `0.3.0` is **experimental source software**. Static generation and validation do not run repository commands and do not prove that the repository builds, tests, or works in production.

## Quick start

Requirements: Node.js 20+ and Git.

```sh
git clone https://github.com/mason2048/repo2skill.git
cd repo2skill
npm ci
npm test
npm run ui
```

Open <http://127.0.0.1:4173>. Stop the local server with `Ctrl+C`.

The CLI is also available directly:

```sh
./src/cli.js --help
./src/cli.js inspect /absolute/path/to/a/local-git-repository
./src/cli.js inspect https://github.com/owner/repository
```

## Generate a Skill

First inspect a repository and review candidate IDs. Then create a new output directory outside the input repository:

```sh
./src/cli.js generate /absolute/path/to/repository \
  --output /absolute/path/to/new-generated-skill \
  --target codex \
  --exclude cmd-example1,cmd-example2
```

Targets are `generic`, `codex`, `claude`, and `copilot`. Repo2Skill writes only inside the new output directory. It never installs the generated package or writes to Agent configuration directories.

At least three verified, non-conflicting workflows are required. `generate`, `validate`, and `diff` all report `insufficient-workflows` and exit with code `2` when that gate is not met.

## Validate and compare

```sh
./src/cli.js validate /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill

./src/cli.js diff /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill
```

Add `--no-write` to either command to print a report without updating the package. `diff` returns `0` for current, `3` for stale, and `2` for blocked. Usage or runtime errors return `1`.

## Output

```text
generated-skill/
├── SKILL.md
├── references/source-map.json
├── reports/validation.json
├── reports/security.md
├── reports/staleness.json       # after a written diff
├── agents/target.json
├── agents/INSTALL.md
├── agents/openai.yaml           # Codex only
└── context-package.json
```

Every mapped workflow includes repository identity, locked revision, source locator, content hash, file mode, and verification evidence.

## Public GitHub input

Only an exact credential-free `https://github.com/<owner>/<repo>[.git]` URL is accepted. SSH, `file://`, alternate hosts, query strings, fragments, embedded credentials, and private repositories are outside the current scope. Public sources are shallow-cloned into an isolated cache and inspected at a clean detached HEAD.

Default caches:

- macOS: `~/Library/Caches/repo2skill/github-v1/`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/repo2skill/github-v1/`
- Windows: `%LOCALAPPDATA%/repo2skill-cache/github-v1/`

Override the cache with `--cache /absolute/path/to/cache`.

## Safety boundary

Repository content is untrusted data. Repo2Skill never runs repository scripts, hooks, generated instructions, or discovered commands. It blocks dangerous shell syntax, suspected secrets, unreviewed executable scripts, unsafe display metadata, repository identity mismatches, source changes, and insufficient workflow evidence. A human must still inspect the source map and security report before installing or running anything.

## Verification

```sh
npm run check
npm test
npm audit
```

See the [user guide](docs/USER_GUIDE.md) for the full UI and CLI procedure, manual installation, cache cleanup, generated-output cleanup, and troubleshooting.

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Licensed under the [Apache License 2.0](LICENSE).
