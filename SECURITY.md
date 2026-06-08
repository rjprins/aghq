# Security Policy

## Important Context

agmux manages PTY (pseudo-terminal) sessions and streams terminal output over WebSockets. By design, it provides shell access to the local machine. This makes security considerations especially important.

**agmux binds to `127.0.0.1` (localhost) by default** and generates a random auth token on each start. These defaults are intentional — do not expose agmux to the public internet.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Email your report to the maintainers (see the repository contact info).
3. Include steps to reproduce the issue and any relevant details.
4. You should receive a response within 72 hours.

## Scope

The following are in scope for security reports:

- Authentication bypass (token validation issues)
- WebSocket origin validation bypass
- Path traversal or command injection via API endpoints
- Unauthorized access to PTY sessions
- Information disclosure through API responses

The following are **not** in scope:

- Issues that require the attacker to already have local shell access (agmux is a local tool)
- Denial-of-service on localhost
- Issues in upstream dependencies (report those to the respective projects)

## Supported Versions

Only the latest release is supported with security updates.
