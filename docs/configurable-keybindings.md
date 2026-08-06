# Spec: Configurable keybindings

## Objective

Let users change agmux-owned global shortcuts directly from the Keybindings popup so browser, operating-system, and terminal conflicts can be avoided without editing configuration files.

## Tech stack

- TypeScript 5.9
- Preact 10.28
- Fastify 5.7
- Vitest 4 and Playwright 1.58

## Commands

- Build: `npm run build`
- Unit tests: `npm test`
- Browser tests: `npm run e2e`
- Development server: `npm run dev`

## Project structure

- `src/shared/keybindings.ts`: action catalog, defaults, validation, formatting, and matching
- `src/server/routes/settings.ts`: persisted settings validation
- `src/ui/app.ts`: capture state, persistence, and shortcut dispatch
- `src/ui/keybindings-popup-view.tsx`: accessible click-to-capture popup
- `test/`: binding and route validation tests
- `e2e/`: capture, persistence, and dispatch coverage

## Code style

Bindings use physical `KeyboardEvent.code` values and explicit modifier flags:

```ts
const binding: Keybinding = {
  code: "KeyM",
  ctrl: false,
  shift: true,
  alt: true,
  meta: false,
};
```

Keep validation and matching pure. Keep browser events and persistence in the UI coordinator.

## Testing strategy

- Unit-test parsing, strict validation, duplicate detection, formatting, and event matching.
- Route-test malformed settings rejection and normalized reads.
- Browser-test click-to-capture, action suppression during capture, persistence after reload, reset, and use of the rebound Claude shortcut.
- Inspect focus, status messaging, layout, and console output in a real browser.

## Boundaries

- Always: expose every agmux-owned global shortcut listed in the popup as a button.
- Always: persist overrides through `/api/settings` and retain existing defaults when no override exists.
- Always: require `Ctrl`, `Alt`, or `Meta` so normal terminal typing cannot become a global shortcut.
- Always: reject duplicate resolved bindings.
- Always: let `Escape` cancel capture and bare `Backspace` restore the selected action's default.
- Never: treat “Select text / Copy to clipboard” as a configurable shortcut.
- Never: run an application action while its replacement shortcut is being captured.

## Success criteria

- Clicking a shortcut changes its button to a clear capture state and focuses it.
- The next valid key combination is saved immediately and shown in the popup.
- Invalid or duplicate combinations show an inline error and keep capture active.
- Overrides survive a page reload and malformed persisted settings safely fall back to defaults.
- Rebinding the Claude model preset action changes both opening and cycling behavior.
- The current default bindings remain unchanged for users without overrides.
- The popup explains that browser-reserved shortcuts cannot be captured if the browser does not deliver them to the page.

## Open questions

None. Browser-reserved shortcuts are outside agmux's control; users must choose a combination the browser delivers to the page.
