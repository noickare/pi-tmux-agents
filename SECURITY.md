# Security Policy

## Supported versions

Security fixes are made on the latest tagged release. Older releases may not receive fixes.

| Version | Supported |
| --- | --- |
| Latest tagged release | Yes |
| Older releases and untagged commits | No |

Because the project is pre-1.0, a security fix may include an intentional protocol or configuration break. Any required user action will be documented in the release notes and [updating guide](docs/UPDATING.md).

## Report a vulnerability privately

Do not open a public issue for an unpatched vulnerability. Submit a private report through [GitHub Security Advisories](https://github.com/noickare/pi-tmux-agents/security/advisories/new).

Include, when possible:

- the affected version and platform;
- the impact and the trust boundary that is crossed;
- minimal reproduction steps or a proof of concept;
- any suggested mitigation;
- whether the issue has been disclosed elsewhere.

Do not include real credentials, private repository contents, or unredacted child transcripts. Maintainers handle reports on a best-effort basis and will coordinate disclosure after a fix or mitigation is available; this volunteer project does not promise a response SLA.

Dependency or Pi vulnerabilities that are not caused by this extension should also be reported to the affected upstream project.

## Security model

Pi extensions execute with the user's system permissions. A child agent can use every tool granted to it, and its transcript may contain sensitive repository or command output.

`pi-tmux-agents` therefore:

- requires explicit trust before loading project-local agent definitions or configuration;
- launches commands with argv arrays rather than shell interpolation;
- stores control state with restrictive permissions;
- disables extension discovery in child agents to prevent recursive orchestration;
- does not silently run `sudo`, install packages, edit tmux configuration, push remotes, or force Git operations;
- isolates mutating agents in dedicated Git worktrees;
- caps model-visible summaries while retaining complete local results for review.

These controls do not sandbox the model or its tools. Users should:

- review this extension and third-party agent definitions before enabling them;
- grant children only the tools needed for their task;
- use read-only children for inspection work;
- inspect diffs and validation results before merging;
- protect secrets from command output and logs;
- treat `~/.pi/agent/subagents/` as sensitive local data.

See [Architecture](docs/ARCHITECTURE.md#security-boundaries) for the implemented trust boundaries.
