# Repo2Skill user guide

[中文操作手册](USER_GUIDE.zh-CN.md)

## 1. Install and verify

Install Node.js 20+ and Git, then run:

```sh
git clone https://github.com/mason2048/repo2skill.git
cd repo2skill
npm ci
npm run check
npm test
```

No package install script scans another repository or executes its commands.

## 2. Use the local UI

```sh
npm run ui
```

Open <http://127.0.0.1:4173>. Choose **Local repository** or **Public GitHub**, enter the source, select a target Agent, and inspect it. Review repository identity, revision, scanned scope, candidates, conflicts, and security findings. Deselect incorrect candidates, choose a new output directory outside the repository, and generate. Stop the server with `Ctrl+C`.

Use another loopback port if required:

```sh
./src/cli.js serve --port 4300
```

The server refuses non-loopback hosts. Browser generation is bound to the inspected repository identity, revision, and snapshot; a changed repository must be inspected again.

## 3. Inspect with the CLI

```sh
./src/cli.js inspect /absolute/path/to/local-git-repository
./src/cli.js inspect https://github.com/owner/repository
```

The JSON preview contains the locked revision, scan metadata, candidates, selected workflows, conflicts, and security blockers. Candidate commands are static evidence only; they have not been run.

For a public repository with a dedicated cache:

```sh
./src/cli.js inspect https://github.com/owner/repository \
  --cache /absolute/path/to/repo2skill-cache
```

Only public credential-free GitHub HTTPS URLs are accepted.

## 4. Generate

```sh
./src/cli.js generate /absolute/path/to/repository \
  --output /absolute/path/to/new-generated-skill \
  --target generic
```

The output must not exist and must be outside the input repository. Valid targets:

- `generic`: Agent Skills layout guidance;
- `codex`: adds `agents/openai.yaml`;
- `claude`: Claude Code installation guidance;
- `copilot`: GitHub Copilot installation guidance.

Exclude reviewed candidate IDs with:

```sh
./src/cli.js generate /absolute/path/to/repository \
  --output /absolute/path/to/new-generated-skill \
  --target codex \
  --exclude cmd-example1,cmd-example2
```

Generation requires at least three verified, non-conflicting workflows. A blocked generation still creates an auditable package report but exits `2`; do not install or use it.

## 5. Validate

```sh
./src/cli.js validate /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill
```

Validation checks package structure, repository identity, revision, source existence, hashes, modes, command mappings, target metadata, current conflicts, security findings, and the three-workflow minimum. By default it atomically refreshes `reports/validation.json`.

Use `--no-write` for a read-only check:

```sh
./src/cli.js validate /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill \
  --no-write
```

## 6. Compare revisions

```sh
./src/cli.js diff /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill
```

The report classifies each mapping as `unchanged`, `changed`, `superseded`, `missing`, `unverified`, or `conflicted`. It writes `reports/staleness.json` unless `--no-write` is used.

Exit codes:

- `0`: completed with no blocker; `diff` is current;
- `1`: invalid arguments or runtime/network/filesystem error;
- `2`: blocked, including `insufficient-workflows`;
- `3`: `diff` completed but the Skill is stale.

## 7. Install manually

Open the generated `agents/INSTALL.md` and inspect all of these before copying anything:

1. `reports/security.md` has no unreviewed blocker;
2. `reports/validation.json` is not blocked;
3. `references/source-map.json` matches the intended repository and revision;
4. every selected command and source is expected;
5. the destination is the correct project-local Skill directory for the target Agent.

Repo2Skill deliberately performs no installation, linking, global configuration, or command execution.

## 8. Clean up

Generated packages are independent directories. After verifying the exact path, move only the unwanted generated directory to Trash. Never use the input repository as output.

Public-repository cache locations are listed in the README. Stop Repo2Skill, verify the exact cache namespace, and move only that cache directory to Trash if you want to reclaim space. The cache can be recreated from the public URL. Do not delete a broad home or system cache directory.

To uninstall the source preview, stop the server and remove only the cloned `repo2skill` directory. It stores no account or cloud data.

## 9. Troubleshooting

- **`insufficient-workflows`:** the current selected set has fewer than three verified, non-conflicting categories. Add repository-backed workflow evidence or select more valid candidates; do not bypass the blocker.
- **Output exists:** choose a new path. Repo2Skill never overwrites an existing output.
- **Output inside repository:** choose a sibling or temporary directory outside it.
- **Repository changed after preview:** inspect again before generation.
- **Public URL rejected:** use exact credential-free `https://github.com/owner/repository`; private repositories are unsupported.
- **Cache unsafe or busy:** stop concurrent runs and inspect the exact cache entry for links or unexpected files; use a new empty cache root if uncertain.
- **Executable-script blocker:** manually review the cited executable. Repo2Skill will not run it.
- **Validation changed-reference blocker:** regenerate from the intended current revision after reviewing the diff.
- **Port in use:** choose another value from 0 to 65535 with `serve --port`; port `0` lets the OS select one.

For reproducible non-sensitive bugs, open a GitHub issue. Use Private Vulnerability Reporting for security findings.
