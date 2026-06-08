# Agent API Reference (Current `/api/*` + `/ws`)

This document describes the **current** agmux API surface that the UI uses today.
Agents can use the same endpoints directly.

This is a behavior reference, not a versioned compatibility guarantee.

OpenAPI source of truth:

- `docs/openapi.json`

CI guard:

- `test/openapi-coverage.test.ts` fails if any current `/api/*` route is missing from `docs/openapi.json`.

## Base URL

- HTTP: `http://127.0.0.1:<port>`
- WebSocket: `ws://127.0.0.1:<port>/ws`

## Authentication

When `AGMUX_TOKEN_ENABLED=1`, all `/api/*` routes and `/ws` require a token.

Supported token transport:

- Header: `x-agmux-token: <token>`
- Header: `Authorization: Bearer <token>`
- Query: `?token=<token>`

When auth is disabled, no token is required.

## Conventions

- Content type: JSON
- Typical error shape:

```json
{ "error": "message" }
```

- Query/body parameters are validated per-route.
- Unknown extra JSON fields are generally ignored.

## PTY and Session Endpoints

### `GET /api/ptys`

Returns active and recent PTY summaries.

Response:

```json
{ "ptys": [/* PtySummary[] */] }
```

### `GET /api/readiness/trace`

Query:

- `ptyId` (optional)
- `limit` (optional integer, clamped to `1..2000`, default `200`)

Response:

```json
{ "events": [/* readiness trace events */] }
```

### `POST /api/readiness/report`

Explicitly marks a PTY `ready` or `busy` from a Claude hook or Codex notify callback.

This signal overrides the heuristic tmux pane readiness fallback until the next submitted command or explicit busy report.

Body:

- `provider` (required: `claude` or `codex`)
- `state` (optional: `ready` or `busy`, default `ready`)
- `reason` (optional string)
- `ptyId` (optional string)
- `tmuxSession` (optional string, used when `ptyId` is not available)

At least one of `ptyId` or `tmuxSession` is required.

Success:

```json
{ "ok": true, "id": "pty_123" }
```

### `POST /api/ptys/launch`

Launches a tmux-backed PTY, optionally creates a new worktree and starts an agent command.

Body:

- `agent` (required string, for example `shell`, `codex`, `claude`)
- `worktree` (required string path, or `"__new__"`)
- `projectRoot` (optional string path)
- `branch` (optional string, used when `worktree="__new__"`)
- `baseBranch` (optional string, default server base branch)
- `flags` (optional object of `string | boolean` values)
- `taskRef` (optional object):
  - `projectRoot` (required)
  - `provider` (required)
  - `taskId` (required)
  - `worktreePath` (optional)

Success:

```json
{ "id": "pty_..." }
```

Errors:

- `400` invalid body/path/worktree/taskRef/shell validation

### `POST /api/ptys/shell`

Spawns a shell PTY in agmux tmux.

Success:

```json
{ "id": "pty_..." }
```

Errors:

- `400` invalid shell configuration

### `POST /api/ptys/attach-tmux`

Attaches an existing tmux session.

Body:

- `name` (required string)
- `server` (optional `"agmux"` or `"default"`)

Success (new attach):

```json
{ "id": "pty_..." }
```

Success (already attached):

```json
{ "id": "pty_...", "reused": true }
```

Errors:

- `400` invalid input or linked-view session attach attempt
- `404` tmux session not found
- `409` tmux server mismatch or attached elsewhere

### `POST /api/ptys/:id/kill`

Kills PTY and its tmux window when applicable.

Success:

```json
{ "ok": true }
```

Errors:

- `404` unknown PTY

### `POST /api/ptys/:id/resume`

Legacy endpoint.

If PTY is still running:

```json
{ "id": "pty_...", "reused": true }
```

Otherwise:

- `410` with deprecation message

### `POST /api/ptys/:id/task`

Assigns a task reference to a PTY.

Body:

- `taskRef` object (same shape as launch `taskRef`)

Success:

```json
{ "ok": true, "assignment": {/* assignment */} }
```

Errors:

- `404` unknown PTY
- `400` invalid taskRef

### `DELETE /api/ptys/:id/task`

Clears PTY task assignment.

Success:

```json
{ "ok": true }
```

Errors:

- `404` unknown PTY

### `GET /api/input-history`

Returns saved per-session input history.

Response:

```json
{ "history": [/* persisted input history entries */] }
```

### `PUT /api/ptys/:id/input-history`

Upserts input history metadata for a PTY id.

Body:

- `lastInput` (optional string)
- `processHint` (optional string)
- `history` (array of `{ text: string, bufferLine?: number }`)

Success:

```json
{ "ok": true }
```

## Agent Session Endpoints

### `GET /api/agent-sessions`

Returns discovered/restorable agent sessions.

Response:

```json
{ "sessions": [/* AgentSessionSummary[] */] }
```

### `POST /api/agent-sessions/:provider/:sessionId/restore`

Restores a discovered session into a new tmux-backed PTY.

Path:

- `provider`: `claude | codex | pi`
- `sessionId`: provider session id

Body:

- `target` (optional): `same_cwd | worktree | new_worktree` (default `same_cwd`)
- `cwd` (optional string)
- `worktreePath` (required if `target=worktree`)
- `branch` (optional if `target=new_worktree`)

Success:

```json
{ "id": "pty_..." }
```

Errors:

- `400` bad provider/params/body
- `404` unknown session
- `409` worktree creation conflict
- `500` restore failure

### `GET /api/agent-sessions/:provider/:sessionId/conversation`

Returns parsed conversation messages from the provider log file when available.

Success:

```json
{ "messages": [/* provider log messages */] }
```

Errors:

- `400` invalid provider/sessionId
- `404` log file not found

## Worktree Endpoints

### `GET /api/directory-exists?path=<path>`

Success:

```json
{ "exists": true }
```

Errors:

- `400` missing `path`

### `GET /api/worktrees[?projectRoot=<path>]`

Success:

```json
{
  "repoRoot": "/repo",
  "worktrees": [
    { "name": "main", "path": "/repo", "branch": "main" }
  ]
}
```

### `GET /api/default-branch[?projectRoot=<path>]`

Success:

```json
{ "branch": "main" }
```

### `GET /api/worktrees/status?path=<worktreePath>`

Success:

```json
{ "dirty": false, "branch": "feature/x", "changes": [] }
```

Errors:

- `400` missing/unknown worktree path
- `500` status failure

### `DELETE /api/worktrees`

Body:

- `path` (required string, must be known worktree)

Success:

```json
{ "ok": true }
```

Errors:

- `400` invalid path
- `500` remove failure

## Task Provider and Task Endpoints

### Provider config

- `GET /api/tasks/provider[?projectRoot=<path>]`
- `PUT /api/tasks/provider`
- `POST /api/tasks/provider/verify`
- `DELETE /api/tasks/provider?projectRoot=<path>`

Provider `type` must be one of:

- `beads`
- `jira`
- `azure-devops`

`PUT` and `verify` body:

```json
{
  "projectRoot": "/repo",
  "type": "beads",
  "options": {}
}
```

### Tasks

- `GET /api/tasks[?projectRoot=<path>&status=open,in-progress&priority=1,2&ready=1]`
- `GET /api/tasks/:id[?projectRoot=<path>]`
- `POST /api/tasks`
- `PATCH /api/tasks/:id`
- `POST /api/tasks/:id/transition`
- `DELETE /api/tasks/:id`

Create body example:

```json
{
  "projectRoot": "/repo",
  "title": "Fix bug",
  "description": "details",
  "status": "open",
  "priority": 2,
  "links": [{ "type": "related", "targetId": "123" }]
}
```

Update body example:

```json
{
  "projectRoot": "/repo",
  "title": "New title",
  "status": "in-progress",
  "priority": 1,
  "addLinks": [{ "type": "blocks", "targetId": "456" }],
  "removeLinks": [{ "type": "related", "targetId": "123" }]
}
```

Transition body:

```json
{ "projectRoot": "/repo", "status": "closed" }
```

## tmux Inspection Endpoints

### `GET /api/tmux/sessions`

Returns tmux sessions (excluding internal linked-view sessions).

Response:

```json
{ "sessions": [/* TmuxSessionInfo[] */] }
```

### `GET /api/tmux/check?name=<session>&server=<agmux|default>`

Success:

```json
{ "checks": {/* TmuxSessionCheck */} }
```

Errors:

- `400` missing/invalid query
- `404` session not found on requested server

## Trigger Endpoint

### `POST /api/triggers/reload`

Reloads trigger module from `TRIGGERS_PATH`.

Success:

```json
{ "ok": true }
```

## Settings Endpoints

### `GET /api/launch-preferences`

Returns stored launch preferences object.

### `PUT /api/launch-preferences`

Merges provided launch preference keys into the stored preference object.

Body:

```json
{ "agent": "codex", "flags": { "codex": { "--sandbox": "workspace-write" } } }
```

Optional:

- `projectRoot` (string): when present, saves preferences scoped to that project root instead of global launch preferences

Response: merged launch preferences object.

### `GET /api/settings`

Returns stored settings object.

### `PUT /api/settings`

Merges provided keys into stored settings. Keys set to `null` are deleted.

Body:

```json
{ "theme": "dracula", "someKey": null }
```

Response: merged settings object.

## WebSocket Endpoint

### Connect

- URL: `/ws`
- Token rules: same as HTTP when auth is enabled

On connect, server immediately sends:

- `pty_list`

### Client -> Server messages

All messages are JSON.
Maximum inbound WS message size is 256 KiB.

1) Subscribe for output stream:

```json
{ "type": "subscribe", "ptyId": "pty_..." }
```

2) Send raw terminal input:

```json
{ "type": "input", "ptyId": "pty_...", "data": "ls -la\n" }
```

Constraints:

- `data` max 64 KiB

3) Mobile submit helper:

```json
{ "type": "mobile_submit", "ptyId": "pty_...", "body": "echo hi" }
```

Constraints:

- `body` max 64 KiB

4) Resize:

```json
{ "type": "resize", "ptyId": "pty_...", "cols": 120, "rows": 30 }
```

Constraints:

- `cols`, `rows`: integer `1..1000`

5) tmux history control:

```json
{ "type": "tmux_control", "ptyId": "pty_...", "direction": "up", "lines": 20 }
```

Constraints:

- `direction`: `up | down`
- `lines`: integer `1..200`

6) Snapshot request:

```json
{ "type": "mobile_snapshot_request", "requestId": "r1", "ptyId": "pty_...", "lines": 200 }
```

Constraints:

- `requestId` length `1..128`
- `lines` integer `1..20000`

### Server -> Client messages

Event types:

- `pty_list`
- `pty_output` (only for subscribed PTYs)
- `pty_exit`
- `pty_ready`
- `trigger_fired`
- `pty_highlight`
- `trigger_error`
- `mobile_snapshot_response` (`ok=true` or `ok=false`)

Canonical type definitions live in:

- `src/shared/protocol.ts`

## Minimal Agent Workflow Example

1) `POST /api/ptys/shell` -> get `ptyId`
2) Connect `/ws` and send:

```json
{ "type": "subscribe", "ptyId": "<ptyId>" }
```

3) Send command:

```json
{ "type": "input", "ptyId": "<ptyId>", "data": "echo hello\n" }
```

4) Wait for `pty_output` containing `hello`
5) `POST /api/ptys/<ptyId>/kill`
