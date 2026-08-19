# Security policy

## Supported versions

Repo2Skill `0.3.x` is experimental source software. Security fixes are made on the default branch; there is no hosted service, binary release, or production support commitment.

## Report a vulnerability privately

Do not open a public issue for suspected command execution, repository escape, unsafe cache behavior, credential exposure, generated-package injection, path disclosure, or local-server bypass.

Use the repository **Security** tab and select **Report a vulnerability**:

<https://github.com/mason2048/repo2skill/security/advisories/new>

Include the affected revision, platform and Node/Git versions, a minimal synthetic repository, reproduction steps, impact, and a redacted proof of concept. Do not submit real credentials, private repositories, user paths, or generated packages containing private data. You should receive an initial acknowledgement within seven days. Disclosure will be coordinated after impact and remediation are understood.

## Security boundary

Repo2Skill treats repository contents as untrusted static data and never runs discovered commands, scripts, generated instructions, or Git hooks. Generated output still requires human review. Pattern-based checks and static source evidence cannot prove that a command is safe or correct.
