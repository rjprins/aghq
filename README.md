# agmux

## Install prompt

Paste this into your coding agent:

```text
Checkout https://github.com/rjprins/agmux in a tmp directory and run it so I can try it out and make my own changes
```

> [!IMPORTANT]
> **Personal Software**
>
> agmux is shaped around one developer's workflow, so it carries specific functional idiosyncrasies and rough edges, and comes with no promise of stability or support. That said, the core model, a browser terminal (xterm.js) over tmux-backed PTYs for managing coding agents, is solid, and others may find it useful to fork and tweak.

Local web UI for managing agent terminal sessions. Streams PTY output to the browser over WebSockets, with customizable triggers and Claude/Codex readiness callbacks backed by tmux pane inference fallback.

Built for managing [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), and other CLI-based coding agents — but works with any terminal program.

<p align="center">
  <img src="docs/screenshot.png" alt="agmux web UI" width="820">
</p>

## Features

- **Live terminal dashboard** — stream tmux-backed PTYs over WebSockets, switch sessions quickly, rename/kill sessions, and keep shells alive across server restarts.
- **Agent launch workflows** — start shells, Codex, Claude, or custom CLI agents in an existing worktree, a new worktree, or the current project, with saved flags and launch preferences.
- **Worktree-aware sidebar** — group projects, sort sessions by worktree, pin or archive projects, and keep same-worktree sessions visually tied together by their left rail color.
- **Readiness detection** — mark Claude/Codex sessions ready through callbacks, with tmux pane inference as a fallback for prompts, permission requests, and idle shells.
- **Inactive session discovery and restore** — discover recent Claude, Codex, and Pi sessions from provider logs, preview conversations, and restore them into the same cwd, an existing worktree, or a new worktree.
- **PR review context** — poll Azure DevOps PR state for active sessions, surface unresolved/new comment markers, and expand review threads from the PR bar.
- **Task context** — configure project task providers, list/update Beads tasks, and attach task references to launched or running sessions.
- **MCP control surface** — expose local tools for listing PTYs, sending input, taking snapshots, launching agents, attaching tmux sessions, renaming/killing PTYs, and restoring agent sessions.
- **Trigger system** — hot-reload custom triggers from `triggers/index.js`, match terminal output, and orchestrate sessions through trigger hooks.
- **Desktop and mobile UI** — use the full desktop terminal view or a mobile-first agent view with quick prompts, scrollback snapshots, and touch-friendly controls.
- **Local-first safety controls** — optional token auth for `/api/*` and `/ws`, loopback binding by default, theme/settings persistence, input history, and tmux inspection helpers.

## Prerequisites

- **Node.js** v22+
- **npm**
- **tmux** (for persistent sessions — the default backend)
- **C++ toolchain** (`build-essential` on Debian/Ubuntu) for native addons

On Ubuntu/Debian:
```sh
sudo apt install tmux build-essential
```

See [docs/dependencies.md](docs/dependencies.md) for the full list.

## Quick Start

```sh
git clone https://github.com/rjprins/agmux.git
cd agmux
npm install
npm run dev
```

This starts the app with auto-rebuild and auto-reload.

- App: `http://127.0.0.1:4821`

If you get "address already in use", pick a different port:
```sh
PORT=4823 npm run dev
```

Start app only (no file watching):
```sh
npm run app
```

## Triggers

Edit `triggers/index.js`. The server watches the `triggers/` folder and hot-reloads on change.

An example trigger is included that highlights the PTY in the UI when a `proceed (y)?` prompt is detected.

Trigger `onMatch(ctx)` handlers can also orchestrate other sessions via `ctx.hooks`:

- `ctx.hooks.writeTo(ptyId, data)` — write input to another running PTY
- `ctx.hooks.listPtys()` — inspect current PTY summaries
- `ctx.hooks.spawnShell({ cwd?, name? })` — spawn a new tmux-backed shell PTY

## Agent API

Use the current UI API surface directly for agents:

- HTTP + WS reference: [docs/agent-api-reference.md](docs/agent-api-reference.md)
- OpenAPI spec: [docs/openapi.json](docs/openapi.json)
- MCP server: [docs/mcp.md](docs/mcp.md)

## Claude / Codex readiness

Claude and Codex callbacks are the preferred readiness signal. If those callbacks are not configured or do not fire, agmux falls back to the original tmux pane-based readiness inference.

A PTY becomes `ready` immediately when:

- Claude Code fires a `Notification` hook such as `idle_prompt` or `permission_prompt`
- Codex runs its `notify` callback after a turn completes

Without an explicit callback, agmux still infers readiness from visible tmux pane state:

- changing pane content keeps the PTY `busy`
- a stable prompt long enough marks the PTY `ready`
- visible permission prompts also count as `ready`

Every agmux-created shell exports these variables:

- `AGMUX_PTY_ID`
- `AGMUX_TMUX_SESSION`
- `AGMUX_API_BASE`
- `AGMUX_READY_HELPER`
- `AGMUX_TOKEN` when token auth is enabled

Example Claude hooks:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "idle_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$AGMUX_READY_HELPER\" claude idle_prompt"
          }
        ]
      },
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$AGMUX_READY_HELPER\" claude permission_prompt"
          }
        ]
      }
    ]
  }
}
```

Example Codex config:

```toml
notify = ["node", "/absolute/path/to/agmux/scripts/agent-ready.mjs", "codex", "turn_complete"]
```

Using the exported helper is preferred inside agmux-created shells because it already knows the current PTY and auth token.

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `4821` | Server port |
| `DB_PATH` | `data/agmux.db` | SQLite database path |
| `TRIGGERS_PATH` | `triggers/index.js` | Trigger definitions file |
| `AGMUX_TOKEN_ENABLED` | `false` | Enable auth token enforcement for `/api/*` and `/ws` |
| `AGMUX_TOKEN` | *(generated if enabled and unset)* | Auth token value when `AGMUX_TOKEN_ENABLED=1` |
| `AGMUX_LOG_LEVEL` | `warn` | Fastify log level (`fatal`,`error`,`warn`,`info`,`debug`,`trace`) |
| `AGMUX_SHELL` | `$SHELL` or `bash` | Shell for PTY sessions |
| `AGMUX_SHELL_BACKEND` | `tmux` | PTY backend: `tmux` or `pty` |
| `AGMUX_NO_OPEN` | `false` | Skip auto-opening browser |
| `AGMUX_ALLOW_NON_LOOPBACK` | `false` | Allow binding to non-localhost addresses |
| `AGMUX_ALLOWED_ORIGINS` | | Additional WebSocket origins (comma-separated) |
| `AGMUX_INACTIVE_MAX_AGE_HOURS` | `24` | Hide non-running sessions older than this |
| `AGMUX_LOG_SESSION_DISCOVERY` | `1` | Enable/disable inactive discovery from JSONL logs |
| `AGMUX_LOG_SESSION_SCAN_MAX` | `500` | Max JSONL files scanned per discovery refresh |
| `AGMUX_LOG_SESSION_CACHE_MS` | `5000` | Cache lifetime for discovered log sessions |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Root used for Claude log discovery |
| `CODEX_HOME` | `~/.codex` | Root used for Codex log discovery |
| `PI_HOME` | `~/.pi` | Root used for Pi log discovery |

### Optional auth token

By default, agmux does **not** require an auth token.

To enable auth explicitly, set `AGMUX_TOKEN_ENABLED=1`:

```sh
AGMUX_TOKEN_ENABLED=1 npm run app
```

With `AGMUX_TOKEN_ENABLED=1`:

- if `AGMUX_TOKEN` is set, that value is used
- if `AGMUX_TOKEN` is unset, agmux generates a random token at startup

When token auth is enabled:

- all `/api/*` endpoints require the token (`x-agmux-token` header, `Authorization: Bearer`, or `?token=...`)
- WebSocket `/ws` requires the token
- browser auto-open includes `?token=...` automatically
- startup logs print a clear token/auth status message

See `docs/auth-token.md` for details and examples.

## Testing

```sh
# Unit tests
npm test

# E2E tests (Playwright)
npm run e2e

# E2E with browser visible
npm run e2e:headed
```

By default, E2E tests use Playwright's managed Chromium. Set `PLAYWRIGHT_CHROMIUM_PATH` to use a system browser instead.

To install Playwright's browser:
```sh
npx playwright install chromium
```

## Notes

- Plain PTYs (created via `/api/ptys`) are not persistent — if the Node server stops, those processes stop too.
- The default "New PTY" shell is tmux-backed, so it survives server restarts.
- Click an inactive session row to attempt resume/re-attach.
- WebSocket output is batched (~16ms flush interval) for performance.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities. agmux runs terminal sessions — please report security issues responsibly.

## License

[MIT](LICENSE)
