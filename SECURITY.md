# Security Policy

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories for this repository. Do not open a public issue for an unpatched vulnerability.

## Security model

Pi extensions execute with the user's system permissions. `pi-tmux-agents` therefore:

- requires explicit trust before using project-local agent definitions;
- launches commands with argv arrays rather than shell interpolation;
- stores control state with restrictive permissions;
- disables extension discovery in child agents to prevent recursive orchestration;
- does not run `sudo`, install packages, edit tmux configuration, push remotes, or force Git operations silently;
- isolates mutating agents in dedicated Git worktrees.

Users should review third-party agent definitions and prompts before enabling them.
