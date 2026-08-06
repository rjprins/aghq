# Spec: Claude model presets

## Objective

Let an agmux user configure named Claude Code model/effort presets and apply one to the active Claude terminal without leaving the keyboard.

## Tech stack

- TypeScript 5.9
- Preact 10.28
- Fastify 5.7
- xterm.js 5.5
- Vitest 4 and Playwright 1.58

## Commands

- Build: `npm run build`
- Unit tests: `npm test`
- Browser tests: `npm run e2e`
- Development server: `npm run dev`

## Project structure

- `src/server/routes/settings.ts`: persisted global settings API
- `src/ui/app.ts`: active terminal state, global shortcuts, and PTY input
- `src/ui/settings-modal-view.tsx`: settings form
- `src/shared/claude-model-presets.ts`: preset validation and terminal command generation
- `src/ui/claude-model-preset-overlay-view.tsx`: keyboard confirmation overlay
- `test/`: unit and route tests
- `e2e/`: browser interaction tests

## Code style

Keep provider-specific behavior in small pure functions and keep terminal writes in the application coordinator:

```ts
const commands = claudePresetCommands(preset);
for (const command of commands) sendTerminalInput(`${command}\r`);
```

Use explicit types, immutable array updates, existing CSS tokens, and native form controls.

## Testing strategy

- Unit-test accepted/rejected settings values and exact Claude terminal commands.
- Route-test settings normalization so malformed persisted data cannot reach the client.
- Browser-test settings CRUD plus `Alt-M`, repeated cycling, `Enter`, and `Escape`.
- Build and run the full unit suite before handoff.

## Boundaries

- Always: send Claude Code's documented `/model <model>` and `/effort <level>` commands through the existing PTY channel.
- Always: assume the user has left the Claude prompt empty; do not inspect the prompt.
- Always: intercept the shortcut before xterm receives it while the chooser is open.
- Ask first: adding Codex support or changing the persistence store.
- Never: submit a preset to a non-Claude session or accept control characters in preset fields.

## Success criteria

- Settings can add, edit, reorder, and remove named Claude presets and persist them through `/api/settings`.
- `Alt-M` opens a modal chooser for an active Claude session and highlights one preset.
- Repeated `Alt-M` cycles the highlight with wraparound.
- `Enter` sends `/model <model>\r` followed by `/effort <level>\r` and closes the chooser.
- `Escape` closes the chooser without terminal input.
- Missing presets or a non-Claude active terminal produce no terminal input and no broken overlay.
- The shortcut appears in the keybindings help.

## Open questions

None. Codex support is explicitly out of scope.
