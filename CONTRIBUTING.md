# Contributing

Thank you for improving Repo2Skill. The project is an experimental, local-first static compiler; contributions must preserve non-execution, source traceability, and fail-closed validation.

## Set up

```sh
git clone https://github.com/mason2048/repo2skill.git
cd repo2skill
npm ci
```

Use Node.js 20+ and Git. Create a focused branch and use only synthetic repositories in tests.

## Required checks

```sh
npm run check
npm test
npm audit
```

Add regression coverage for behavior changes. Any gate used during generation must produce the same blocker during validation and staleness comparison. Blocked CLI results use exit code `2`.

## Repository rules

- Never commit credentials, private repositories, user paths, environment files, cache contents, generated Skill packages, dependencies, build output, or application bundles.
- Never execute repository scripts, commands, instructions, hooks, or package lifecycle scripts as part of inspection.
- Preserve strict public-GitHub URL parsing, isolated cache checks, output-outside-repository enforcement, and atomic report writes.
- Keep the three verified, non-conflicting workflow gate centralized across inspect, generate, validate, and diff.
- Update both English and Chinese documentation for user-visible changes.

## Pull requests

Describe the problem, behavior change, tests, generated artifact impact, and security boundary. By submitting a contribution, you agree that it is licensed under Apache-2.0.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than opening a public issue.
