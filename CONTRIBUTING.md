# Contributing to agmux

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- **Node.js** v22 or later
- **npm**
- **tmux** (for the default shell backend)
- **build-essential** / C++ toolchain (for native addons: `node-pty`, `better-sqlite3`)

On Ubuntu/Debian:
```sh
sudo apt install tmux build-essential
```

See [docs/dependencies.md](docs/dependencies.md) for the full dependency list.

## Development Setup

```sh
# Clone the repo
git clone https://github.com/rjprins/agmux.git
cd agmux

# Install dependencies
npm install

# Start in dev mode (auto-rebuild, auto-reload)
npm run dev

# Or start the app only (no file watching)
npm run app
```

## Running Tests

**Unit tests** (Vitest):
```sh
npm test
```

**E2E tests** (Playwright):
```sh
# Uses system Chromium by default. Set PLAYWRIGHT_CHROMIUM_PATH to override.
# To use Playwright's managed browser instead:
npx playwright install chromium

npm run e2e
```

## Project Structure

```
src/
  server.ts          # Fastify HTTP/WS server
  types.ts           # Shared TypeScript types
  tmux.ts            # tmux session management
  persist/           # SQLite persistence layer
  pty/               # PTY lifecycle management
  providers/         # Backend providers (tmux, native pty)
  readiness/         # Agent readiness detection
  triggers/          # Trigger matching engine
  ui/                # Browser UI (bundled with esbuild)
  ws/                # WebSocket hub
triggers/            # User-editable trigger definitions
public/              # Static assets (mostly generated)
test/                # Unit tests
e2e/                 # E2E tests
```

## Making Changes

1. Fork the repo and create a branch from `main`.
2. Make your changes.
3. Add or update tests if applicable.
4. Run `npm test` and `npm run build` to verify nothing is broken.
5. Open a pull request against `main`.

## Code Style

- TypeScript with ES modules (`"type": "module"` in package.json).
- No linter is enforced yet — just follow the existing patterns in the codebase.
- Keep things simple. Avoid over-abstraction.

## Commit Messages

- Use concise, descriptive commit messages.
- Prefix with the area of change when helpful (e.g., "readiness: fix marker detection for Claude 4").

## Reporting Bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) when filing issues. Include:
- Steps to reproduce
- Expected vs actual behavior
- Your OS, Node.js version, and tmux version

## Security Issues

See [SECURITY.md](SECURITY.md) for how to report security vulnerabilities. Do **not** open public issues for security bugs.
