# agmux MCP Server

agmux includes a local stdio MCP server that exposes the existing agmux HTTP/WebSocket API as tools.

## Run

Start agmux first:

```bash
npm run app
```

Build the MCP entry point before configuring external clients:

```bash
npm run build
```

Or install it into both Codex and Claude Code in one step:

```bash
npm run mcp:install
```

This command builds agmux, replaces any existing `agmux` MCP entry, and uses `AGMUX_API_BASE` / `AGMUX_TOKEN` from your environment when set.

For a local smoke test, run the MCP server directly:

```bash
node --import tsx src/mcp/server.ts
```

The server speaks MCP over stdout, so do not put extra logging wrappers in front of it. For MCP clients, prefer `node /absolute/path/to/agmux/dist/mcp/server.js` after `npm run build`. Use `node --import tsx /absolute/path/to/agmux/src/mcp/server.ts` only for local development from this repository.

The MCP server reads:

- `AGMUX_API_BASE`, default `http://127.0.0.1:4821`
- `AGMUX_TOKEN`, required only when agmux token auth is enabled
- `PORT`, used for the default API base when `AGMUX_API_BASE` is unset

## Tools

- `list_ptys` - list active and recent PTYs
- `send_input` - write input to a PTY, submitting with the same delayed Enter flow as the mobile UI by default
- `snapshot` - capture recent PTY text
- `spawn_shell` - create or attach a shell PTY
- `launch_agent` - launch `shell`, `codex`, `claude`, or another CLI agent
- `attach_tmux` - attach an existing tmux session
- `kill_pty` - kill a PTY
- `rename_pty` - rename a PTY
- `list_agent_sessions` - list discovered/restorable agent sessions
- `restore_agent_session` - restore a Claude, Codex, or Pi session

To send a prompt to another agent, call `list_ptys`, pick the target `ptyId`, then call:

```json
{
  "ptyId": "pty_abc123",
  "data": "Please review the current diff."
}
```

## Codex

Codex does not auto-discover local stdio MCP servers. The short command is:

```bash
npm run mcp:install:codex
```

Equivalent CLI form:

```bash
codex mcp add agmux \
  --env AGMUX_API_BASE=http://127.0.0.1:4821 \
  -- node /absolute/path/to/agmux/dist/mcp/server.js
```

If agmux token auth is enabled, add another env flag before `--`:

```bash
--env AGMUX_TOKEN=your-token
```

Verify in Codex:

```bash
codex mcp list
```

Or edit `~/.codex/config.toml` directly:

```toml
[mcp_servers.agmux]
command = "node"
args = ["/absolute/path/to/agmux/dist/mcp/server.js"]
cwd = "/absolute/path/to/agmux"
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.agmux.env]
AGMUX_API_BASE = "http://127.0.0.1:4821"
# AGMUX_TOKEN = "your-token"
```

In the Codex TUI, use `/mcp` to inspect active MCP servers.

## Claude Code

Claude Code also needs explicit MCP configuration. The short command is:

```bash
npm run mcp:install:claude
```

Equivalent CLI form:

```bash
claude mcp add-json --scope user agmux \
  '{"type":"stdio","command":"node","args":["/absolute/path/to/agmux/dist/mcp/server.js"],"env":{"AGMUX_API_BASE":"http://127.0.0.1:4821"}}'
```

If agmux token auth is enabled, include it in the JSON env:

```json
"AGMUX_TOKEN": "your-token"
```

Verify:

```bash
claude mcp list
claude mcp get agmux
```

Inside Claude Code, use `/mcp` to inspect the server status.

For project-scoped configuration, add `.mcp.json`:

```json
{
  "mcpServers": {
    "agmux": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/agmux/dist/mcp/server.js"],
      "env": {
        "AGMUX_API_BASE": "http://127.0.0.1:4821"
      }
    }
  }
}
```

## Generic Client Command

For clients that accept a command/args MCP entry:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/agmux/dist/mcp/server.js"],
  "env": {
    "AGMUX_API_BASE": "http://127.0.0.1:4821",
    "AGMUX_TOKEN": "optional-token"
  }
}
```
