# Spec: Azure DevOps PR launch menu

## Objective

Expose every active Azure DevOps pull request for a project from a compact project-header menu. A user can open the normal launch dialog for a PR, reuse its local source-branch worktree when present, or create that source-branch worktree when absent. A PR-context launch may start a normal agent or invoke `/review-pr <id>`.

## Approved interaction

- Show a `PR` button in the project header only after the project is confirmed to use an Azure DevOps `origin` remote.
- Open an anchored, click-controlled popover. Hover is not required to keep it open.
- List draft and published PRs together, newest activity first.
- Show PR number, title, author, draft state, relative update time, source branch, and matching worktree when present.
- Open the ADO PR when the row body is activated.
- Open the normal launch dialog from the row `+` button.
- Reuse a matching source-branch worktree even when it is dirty.
- If no worktree matches, create one by checking out the PR source branch.
- Show `Launch Review` only when the dialog was opened with explicit PR review context.
- `Launch Review` starts the chosen agent in the selected or created worktree with `/review-pr <id>` as its initial input.
- Refresh PR data once per minute. The first successful load establishes an attention baseline.
- Show attention dots for newly discovered PRs and for known PRs that transition from draft to published.
- Keep attention state across server restarts. A successfully rendered popover acknowledges the events it displayed, while keeping those row markers visible until that popover closes.

## External contract

Microsoft documents active listing, draft filtering, and the `isDraft` field in the Azure CLI and Git REST API:

- https://learn.microsoft.com/en-us/cli/azure/repos/pr?view=azure-cli-latest#az-repos-pr-list
- https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests?view=azure-devops-rest-7.1
- https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1

The PR list schema has no general `updatedDate`. The menu therefore uses the latest PR iteration `updatedDate`, falling back to the PR `creationDate`. This represents the latest code iteration rather than every metadata or comment change.

## API contract

`GET /api/azure-pr/menu?projectRoot=<absolute git root>` returns:

```ts
type AzurePrMenuResponse =
  | { supported: false; projectRoot: string }
  | {
      supported: true;
      projectRoot: string;
      fetchedAt: number;
      prs: Array<{
        id: number;
        title: string;
        author: string;
        isDraft: boolean;
        sourceBranch: string;
        targetBranch: string;
        createdAt: number;
        updatedAt: number;
        url: string;
        worktree: { name: string; path: string; dirty: boolean } | null;
        attention: "new" | "published" | null;
      }>;
    };
```

`POST /api/azure-pr/menu/viewed` accepts the project root and the exact `{ id, attention }` markers displayed by the client. A marker is cleared only if it still matches, so acknowledging an older `new` marker cannot clear a newer `published` event.

External ADO responses are validated and normalized before entering the internal contract. Invalid records are ignored rather than rendered or used to create worktrees.

## Tech stack and project structure

- TypeScript 5.9.3 with Fastify 5.7.4 on the server.
- Preact 10.28.3 for stateless view components.
- Vitest 4.0.18 for unit and route tests.
- Playwright 1.58.2 plus real-browser inspection for the launch flow.
- `src/server/azure-pr.ts` contains ADO CLI boundary functions and normalization.
- `src/server/azure-pr-menu.ts` contains caching and persisted attention transitions.
- `src/server/routes/azure-pr.ts` exposes authenticated HTTP routes.
- `src/ui/pr-menu-view.tsx` renders the popover.
- `src/ui/pty-list-view.tsx` renders the project-header trigger.
- `src/ui/app.ts` owns remote state, polling, popover state, and launch integration.

## Commands

- Install: `npm install`
- Unit and integration tests: `npm test`
- Focused tests: `npm test -- test/azure-pr-menu.test.ts`
- Build and type check: `npm run build`
- Browser tests: `npm run e2e -- --grep "PR menu"`
- Development server: `npm run dev`

## Code style

Use explicit discriminated contracts and early returns that match the existing codebase:

```ts
if (!projectRoot) {
  reply.code(400);
  return { error: "projectRoot is required" };
}

return { supported: true, projectRoot, fetchedAt: Date.now(), prs };
```

Prefer small pure transition functions for attention state. Keep data fetching and persistence outside Preact view components.

## Testing strategy

- Unit-test ADO payload normalization, ordering, worktree matching, first-load baselining, new PR events, draft-to-published events, and event acknowledgement.
- Route-test unsupported repositories, invalid roots, successful lists, and viewed-event validation.
- View-test accessible names, draft labels, attention markers, worktree details, empty states, and the `+` action.
- Browser-test the project trigger, popover dismissal and keyboard behavior, PR-context launch dialog, conditional review action, and launch request payload.
- Run the full suite and build before review and again after review fixes.

## Boundaries

- Always: reuse dirty matching worktrees, preserve external data as escaped text, validate route input, and keep the ordinary launch behavior unchanged.
- Always: hide PR controls for unsupported or failed repository detection.
- Ask first: adding dependencies, changing ADO authentication, or posting PR comments or votes.
- Never: automatically submit comments, change PR state, delete worktrees outside the agmux reap funnel, or show `Launch Review` without explicit PR context.

## Success criteria

- Every active ADO PR, including drafts, appears in the project menu within one refresh interval.
- PR details and source-branch worktree matches are correct.
- A row `+` opens the existing launch dialog with remembered agent settings and the correct destination.
- Missing worktrees are created on the source branch before the session launches.
- `Launch Review` exists only in PR context and sends exactly `/review-pr <id>` as initial input.
- New PR and draft-to-published transitions produce persistent attention dots without flagging the initial baseline.
- Opening a loaded menu acknowledges only the markers it displayed.
- Unit, integration, build, and browser verification pass with no console errors or accessibility regressions.

## Implementation plan

### Slice 1: Backend contract and attention state

- Add failing tests for normalized all-active PR data, last-iteration fallback, cache behavior, worktree matching, and attention transitions.
- Implement the ADO boundary and menu service.
- Expose list and acknowledgement routes.
- Verify with focused tests and build, then commit.

### Slice 2: Project menu and polling

- Add failing view tests for the project trigger and popover states.
- Implement the project-header button, attention dot, anchored popover, and one-minute client refresh.
- Verify focused tests and build, then commit.

### Slice 3: PR-aware launch

- Add failing tests for PR launch context, existing worktree reuse, source-branch creation fields, and the conditional review action.
- Extend the launch dialog without changing ordinary callers.
- Add a focused Playwright flow.
- Verify focused tests and build, then commit.

### Slice 4: Quality gate and integration

- Run the full unit suite, build, and browser verification.
- Review correctness, readability, architecture, security, and performance.
- Fix all required findings and rerun affected checks.
- Merge into `main`, preserve pre-existing local edits, rebuild, restart agmux, and verify service health.

## Open questions

None. The approved interaction and safety boundaries above are implementation-ready.
