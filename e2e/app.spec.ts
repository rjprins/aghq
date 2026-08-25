import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const E2E_TOKEN = process.env.E2E_AGMUX_TOKEN ?? "e2e-token";
const TRIGGERS_FILE = path.resolve("triggers/index.js");
const SWARM_TRIGGER_MODULE = String.raw`export const triggers = [
  {
    name: "proceed_prompt",
    scope: "chunk",
    pattern: /proceed \(y\)\?/i,
    cooldownMs: 1500,
    onMatch: ({ ptyId, ts, match, line, emit }) => {
      emit({
        type: "trigger_fired",
        ptyId,
        trigger: "proceed_prompt",
        match: match[0] ?? "",
        line,
        ts,
      });
      emit({ type: "pty_highlight", ptyId, reason: "trigger:proceed_prompt", ttlMs: 2000 });
    },
  },
  (() => {
    const swarm = {
      controllerPtyId: null,
      workerPtyId: null,
      responded: false,
      launching: false,
    };
    return {
      name: "swarm_spawn_worker",
      scope: "chunk",
      pattern: /START-SWARM/,
      cooldownMs: 2000,
      onMatch: async ({ ptyId, hooks }) => {
        if (swarm.launching) return;
        if (swarm.workerPtyId && !swarm.responded) return;
        swarm.launching = true;
        swarm.controllerPtyId = ptyId;
        swarm.responded = false;
        try {
          const worker = await hooks.spawnShell({ name: "worker:spawned-by-hook" });
          swarm.workerPtyId = worker.ptyId;
          hooks.writeTo(worker.ptyId, "echo WORKER_READY\n");
        } finally {
          swarm.launching = false;
        }
      },
    };
  })(),
  (() => {
    return {
      name: "swarm_worker_ready",
      scope: "line",
      pattern: /^WORKER_READY$/,
      onMatch: ({ ptyId, hooks }) => {
        hooks.writeTo(ptyId, "echo WORKER_ACK_FROM_HOOK\n");
      },
    };
  })(),
];`;

async function readSessionToken(_page: Page): Promise<string> {
  return E2E_TOKEN;
}

type E2EPty = {
  id: string;
  status: string;
  name: string;
};

async function listPtys(page: Page, token: string): Promise<E2EPty[]> {
  const res = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`, { timeout: 5_000 });
  if (!res.ok()) return [];
  const json = (await res.json()) as { ptys?: Array<{ id?: unknown; status?: unknown; name?: unknown }> };
  return (json.ptys ?? [])
    .filter((p): p is { id: string; status?: unknown; name?: unknown } => typeof p?.id === "string")
    .map((p) => ({
      id: p.id,
      status: typeof p.status === "string" ? p.status : "unknown",
      name: typeof p.name === "string" ? p.name : "",
    }));
}

async function listRunningPtys(page: Page, token: string): Promise<string[]> {
  const ptys = await listPtys(page, token);
  return ptys.filter((p) => p.status === "running").map((p) => p.id);
}

// Spawn a plain shell the way the old "New" button did (create + activate).
// The button now opens the launch modal, so tests create shells via the test hook.
async function newShellSession(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as { __agmux?: { newShell?: unknown } }).__agmux?.newShell));
  await page.evaluate(() => (window as { __agmux: { newShell: () => Promise<void> } }).__agmux.newShell());
}

async function writeTriggersAndReload(page: Page, token: string, moduleSource: string): Promise<void> {
  fs.writeFileSync(TRIGGERS_FILE, moduleSource, "utf8");
  const res = await page.request.post(`/api/triggers/reload?token=${encodeURIComponent(token)}`, { timeout: 10_000 });
  if (!res.ok()) {
    throw new Error(`failed to reload triggers: HTTP ${res.status()} ${await res.text()}`);
  }
}

async function killPty(page: Page, token: string, ptyId: string): Promise<void> {
  const res = await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`, {
    timeout: 5_000,
  });
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`failed to kill PTY ${ptyId}: HTTP ${res.status()}`);
  }
}

async function killAllRunningPtys(page: Page, token: string): Promise<void> {
  const running = await listRunningPtys(page, token);
  for (const id of running) {
    await killPty(page, token, id);
  }
}

function runningSidebarItemSelector(ptyId: string): string {
  return `li.pty-item:not(.inactive)[data-pty-id="${ptyId}"]`;
}

async function runningSidebarIds(page: Page): Promise<string[]> {
  return page
    .locator("li.pty-item:not(.inactive)[data-pty-id]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-pty-id") ?? "").filter(Boolean));
}

async function dragRunningSidebarItemBefore(page: Page, sourcePtyId: string, targetPtyId: string): Promise<void> {
  const source = page.locator(runningSidebarItemSelector(sourcePtyId));
  const target = page.locator(runningSidebarItemSelector(targetPtyId));
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("sidebar item bounding box unavailable");

  const sourceX = sourceBox.x + Math.min(36, sourceBox.width / 2);
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + Math.min(36, targetBox.width / 2);
  const targetY = targetBox.y + 2;

  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX, sourceY + 10, { steps: 4 });
  await page.mouse.move(targetX, targetY, { steps: 12 });
  await page.mouse.up();
}

async function ensureNoRunningPtys(page: Page, token: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const running = await listRunningPtys(page, token);
    if (running.length === 0) {
      // Wait for any pending reconcile (fires ~250ms after a kill) to settle,
      // then confirm the count is still zero before declaring success.
      await page.waitForTimeout(500);
      const stillRunning = await listRunningPtys(page, token);
      if (stillRunning.length === 0) return;
      await killAllRunningPtys(page, token);
      await page.waitForTimeout(250);
      continue;
    }
    await killAllRunningPtys(page, token);
    await page.waitForTimeout(250);
  }
  const remaining = await listRunningPtys(page, token);
  throw new Error(`timed out waiting for PTY cleanup: ${remaining.join(", ")}`);
}

async function readRootCssVar(page: Page, name: string): Promise<string> {
  return page.evaluate((cssVar) => document.documentElement.style.getPropertyValue(cssVar).trim(), name);
}

async function ensureInactiveItemVisible(page: Page, itemText: string): Promise<void> {
  const target = page.locator(".pty-item.inactive").filter({ hasText: itemText });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await target.isVisible().catch(() => false)) return;
    await page.evaluate((subheaderText) => {
      const inactiveHeader = [...document.querySelectorAll<HTMLElement>(".pty-group-header")]
        .find((el) => (el.textContent ?? "").includes("Inactive") && el.classList.contains("collapsed"));
      if (inactiveHeader) inactiveHeader.click();

      const inactiveInline = [...document.querySelectorAll<HTMLElement>(".inline-inactive-divider")]
        .find((el) => (el.textContent ?? "").includes("Inactive") && el.classList.contains("collapsed"));
      if (inactiveInline) inactiveInline.click();

      const projectHeader = [...document.querySelectorAll<HTMLElement>(".worktree-subheader")]
        .find((el) => (el.textContent ?? "").includes(subheaderText) && el.classList.contains("collapsed"));
      if (projectHeader) projectHeader.click();
    }, itemText);
    await page.waitForTimeout(250);
  }
  throw new Error(`inactive item did not become visible: ${itemText}`);
}

async function attachTmuxWithRetry(
  page: Page,
  token: string,
  name: string,
  server?: "agmux" | "default",
): Promise<string> {
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const attachRes = await page.request.post(`/api/ptys/attach-tmux?token=${encodeURIComponent(token)}`, {
      data: server ? { name, server } : { name },
    });
    if (attachRes.ok()) {
      const attachJson = (await attachRes.json()) as { id?: unknown };
      const ptyId = typeof attachJson.id === "string" ? attachJson.id : null;
      if (ptyId) return ptyId;
      lastStatus = attachRes.status();
      lastBody = JSON.stringify(attachJson);
    } else {
      lastStatus = attachRes.status();
      lastBody = await attachRes.text();
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`attach-tmux failed for ${name}: status=${lastStatus} body=${lastBody}`);
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  const token = await readSessionToken(page);
  await page.addInitScript((t: string) => {
    sessionStorage.setItem("agmux:authToken", t);
  }, token);
  await ensureNoRunningPtys(page, token);
});

test("normalizes copied terminal selection whitespace", async ({ page }) => {
  await page.goto("/?nosup=1");

  const normalized = await page.evaluate(() => {
    const cleanup = (window as any).__agmux?.cleanupCopiedTerminalText;
    if (typeof cleanup !== "function") return null;
    return cleanup("  alpha   \n    beta\t  \n  \t  \n one-space   \n  omega\u00a0\u00a0");
  });

  expect(normalized).toBe("alpha\n  beta\n\n one-space\nomega");
});

test("can create a PTY and fires proceed trigger", async ({ page }) => {
  await page.goto("/?nosup=1");
  await newShellSession(page);

  // PTY should appear and become active.
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  // Focus the xterm instance and drive the shell.
  await page.locator(".term-pane:not(.hidden) .xterm").click();
  await page.keyboard.type("echo ready; read -p 'proceed (y)? ' x; echo done");
  await page.keyboard.press("Enter");

  // It should print "ready" in the terminal buffer (via a small debug hook).
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("ready");

  // Trigger should fire; assert via temporary sidebar highlight.
  await expect(page.locator(".pty-item.active.highlight")).toHaveCount(1, { timeout: 30_000 });

  // Answer the prompt and ensure the script completes.
  await page.keyboard.type("y");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("done");

  // Cleanup: kill the PTY/tmux session so e2e runs don't leak sessions.
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (ptyId) {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("New button opens the launch modal with searchable pickers", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New" }).click();
  await expect(page.locator(".launch-modal h3")).toContainText("Launch agent");
  // The pickers are the searchable comboboxes, always present.
  await expect(page.getByRole("combobox", { name: "Project directory" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Worktree" })).toBeVisible();
});

test("launch modal and searchable dropdowns stay inside a short viewport", async ({ page }) => {
  for (const viewport of [{ width: 900, height: 500 }, { width: 320, height: 480 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/?nosup=1");
    await page.getByRole("button", { name: "New" }).click();

    const modal = page.locator(".launch-modal");
    await expect(modal).toBeVisible();
    const modalBox = await modal.boundingBox();
    expect(modalBox).not.toBeNull();
    expect(modalBox!.x).toBeGreaterThanOrEqual(0);
    expect(modalBox!.y).toBeGreaterThanOrEqual(0);
    expect(modalBox!.x + modalBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(modalBox!.y + modalBox!.height).toBeLessThanOrEqual(viewport.height);

    for (const name of ["Project directory", "Worktree"]) {
      const picker = page.getByRole("combobox", { name });
      await picker.scrollIntoViewIfNeeded();
      await picker.click();

      const menu = page.locator(".combobox-menu");
      await expect(menu).toBeVisible();
      const menuBox = await menu.boundingBox();
      expect(menuBox).not.toBeNull();
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.y).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width);
      expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport.height);

      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  }
});

test("collapsing the sidebar widens the terminal instead of crushing it", async ({ page }) => {
  const token = await readSessionToken(page);
  await page.goto("/?nosup=1");
  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));

  const terminalWidth = async (): Promise<number> =>
    page.locator("#terminal").evaluate((el) => Math.round(el.getBoundingClientRect().width));

  try {
    // Wait for the initial fit to settle so we have a stable baseline.
    await expect.poll(terminalWidth, { timeout: 10_000 }).toBeGreaterThan(100);
    const expandedWidth = await terminalWidth();

    await page.locator("#btn-sidebar-toggle").click();
    await expect(page.locator("#app")).toHaveClass(/sidebar-collapsed/);

    // Regression: with display:none on the resizer, .main auto-placed into the
    // 0px grid track and #terminal collapsed to ~2px. It must instead widen.
    await expect.poll(terminalWidth, { timeout: 10_000 }).toBeGreaterThan(expandedWidth);
    const collapsedWidth = await terminalWidth();
    expect(collapsedWidth).toBeGreaterThan(400);

    // Expanding again restores the narrower width.
    await page.locator("#btn-sidebar-toggle").click();
    await expect(page.locator("#app")).not.toHaveClass(/sidebar-collapsed/);
    await expect.poll(terminalWidth, { timeout: 10_000 }).toBeLessThan(collapsedWidth);
  } finally {
    if (ptyId) {
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("can reorder running sidebar sessions by dragging", async ({ page }) => {
  const token = await readSessionToken(page);
  const ptyIds: string[] = [];

  try {
    await page.goto("/?nosup=1");
    await page.evaluate(() => localStorage.removeItem("agmux:sidebarPtyOrder"));

    for (let i = 0; i < 2; i += 1) {
      const res = await page.request.post(`/api/ptys/shell?token=${encodeURIComponent(token)}`);
      expect(res.ok()).toBeTruthy();
      const json = (await res.json()) as { id?: unknown };
      if (typeof json.id !== "string") throw new Error("shell response did not include a PTY id");
      ptyIds.push(json.id);
    }

    const [firstPtyId, secondPtyId] = ptyIds;
    if (!firstPtyId || !secondPtyId) throw new Error("expected two PTY ids");

    await expect(page.locator(runningSidebarItemSelector(firstPtyId))).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(runningSidebarItemSelector(secondPtyId))).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await runningSidebarIds(page)).filter((id) => ptyIds.includes(id)), { timeout: 10_000 })
      .toEqual([firstPtyId, secondPtyId]);

    await dragRunningSidebarItemBefore(page, secondPtyId, firstPtyId);

    await expect
      .poll(async () => (await runningSidebarIds(page)).filter((id) => ptyIds.includes(id)), { timeout: 10_000 })
      .toEqual([secondPtyId, firstPtyId]);

    await page.reload();
    await expect(page.locator(runningSidebarItemSelector(firstPtyId))).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(runningSidebarItemSelector(secondPtyId))).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await runningSidebarIds(page)).filter((id) => ptyIds.includes(id)), { timeout: 10_000 })
      .toEqual([secondPtyId, firstPtyId]);
  } finally {
    for (const ptyId of ptyIds) {
      await killPty(page, token, ptyId).catch(() => {});
    }
  }
});

test("trigger hooks can spawn a worker PTY and react to worker output", async ({ page }) => {
  const token = await readSessionToken(page);
  const originalTriggers = fs.readFileSync(TRIGGERS_FILE, "utf8");

  let controllerId: string | null = null;
  let workerId: string | null = null;
  try {
    await writeTriggersAndReload(page, token, SWARM_TRIGGER_MODULE);

    await page.goto("/?nosup=1");
    await newShellSession(page);
    await expect(page.locator(".pty-item.active")).toHaveCount(1);

    controllerId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    expect(controllerId).toBeTruthy();
    if (!controllerId) throw new Error("controller PTY id not found");

    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type("echo START-SWARM");
    await page.keyboard.press("Enter");

    await expect
      .poll(
        async () => {
          const ptys = await listPtys(page, token);
          return ptys.some((p) => p.status === "running" && p.name.includes("worker:spawned-by-hook"));
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    const ptys = await listPtys(page, token);
    const workerPty = ptys.find((p) => p.status === "running" && p.name.includes("worker:spawned-by-hook"));
    expect(workerPty?.name).toContain("worker:spawned-by-hook");
    workerId = workerPty?.id ?? null;
    expect(workerId).toBeTruthy();
    if (!workerId) throw new Error("worker PTY id not found");

    await page.locator(`.pty-item[data-pty-id="${workerId}"]`).click();
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const d = (window as any).__agmux?.dumpActive;
            return typeof d === "function" ? String(d()) : "";
          }),
        { timeout: 30_000 },
      )
      .toContain("WORKER_ACK_FROM_HOOK");
  } finally {
    fs.writeFileSync(TRIGGERS_FILE, originalTriggers, "utf8");
    await page.request.post(`/api/triggers/reload?token=${encodeURIComponent(token)}`).catch(() => {});
    if (workerId) await killPty(page, token, workerId);
    if (controllerId) await killPty(page, token, controllerId);
  }
});

test("mobile UI can send input via composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    (window as any).__agmuxSentWs = sent;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      try {
        if (typeof data === "string") {
          sent.push(JSON.parse(data));
        } else {
          sent.push(String(data));
        }
      } catch {
        sent.push(String(data));
      }
      return originalSend.call(this, data);
    };
  });
  await page.goto("/?nosup=1");

  const token = await readSessionToken(page);
  const createRes = await page.request.post(`/api/ptys/shell?token=${encodeURIComponent(token)}`);
  expect(createRes.ok()).toBeTruthy();
  const createJson = (await createRes.json()) as { id?: unknown };
  const ptyId = typeof createJson.id === "string" ? createJson.id : null;

  await expect(page.locator(".mobile-session-card")).not.toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".mobile-brand-title")).toContainText("agmux", { timeout: 10_000 });
  await page.locator(".mobile-session-card").first().click();
  await expect(page.locator(".mobile-focus")).toHaveCount(1, { timeout: 10_000 });

  const textarea = page.locator(".mobile-composer textarea");
  await textarea.fill("echo mobile-ok");
  await expect(page.locator(".mobile-send")).toBeEnabled();
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("");

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("mobile-ok");

  const mobileSubmitBodies = await page.evaluate(() => {
    const sent = ((window as any).__agmuxSentWs ?? []) as Array<{ type?: unknown; body?: unknown }>;
    return sent
      .filter((msg) => msg && msg.type === "mobile_submit")
      .map((msg) => (typeof msg.body === "string" ? msg.body : ""));
  });
  expect(mobileSubmitBodies).toContain("echo mobile-ok");

  if (ptyId) {
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("mobile session dropdown switches active session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?nosup=1");

  const token = await readSessionToken(page);
  const createOne = await page.request.post(`/api/ptys/shell?token=${encodeURIComponent(token)}`);
  expect(createOne.ok()).toBeTruthy();
  const oneJson = (await createOne.json()) as { id?: unknown };
  const firstId = typeof oneJson.id === "string" ? oneJson.id : null;

  const createTwo = await page.request.post(`/api/ptys/shell?token=${encodeURIComponent(token)}`);
  expect(createTwo.ok()).toBeTruthy();
  const twoJson = (await createTwo.json()) as { id?: unknown };
  const secondId = typeof twoJson.id === "string" ? twoJson.id : null;

  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  if (!firstId || !secondId) return;

  await expect(page.locator(".mobile-session-card")).toHaveCount(2, { timeout: 30_000 });
  await page.locator(`.mobile-session-card[data-pty-id="${firstId}"]`).first().click();
  await expect(page.locator(".mobile-focus")).toHaveCount(1, { timeout: 10_000 });

  await page.locator(".mobile-running-dropdown-toggle").click();
  await expect(page.locator(".mobile-running-dropdown-panel")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(`.mobile-running-dropdown-panel .mobile-session-card[data-pty-id="${firstId}"]`)).toHaveCount(0);
  await page.locator(`.mobile-running-dropdown-panel .mobile-session-card[data-pty-id="${secondId}"]`).click();

  await page.locator(".mobile-running-dropdown-toggle").click();
  await expect(page.locator(".mobile-running-dropdown-panel")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(`.mobile-running-dropdown-panel .mobile-session-card[data-pty-id="${secondId}"]`)).toHaveCount(0);
  await expect(page.locator(`.mobile-running-dropdown-panel .mobile-session-card[data-pty-id="${firstId}"]`)).toHaveCount(1);

  await page.request.post(`/api/ptys/${encodeURIComponent(firstId)}/kill?token=${encodeURIComponent(token)}`);
  await page.request.post(`/api/ptys/${encodeURIComponent(secondId)}/kill?token=${encodeURIComponent(token)}`);
});

test("mobile session view survives refresh and remains interactive", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    (window as any).__agmuxSentWs = sent;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      try {
        if (typeof data === "string") {
          sent.push(JSON.parse(data));
        } else {
          sent.push(String(data));
        }
      } catch {
        sent.push(String(data));
      }
      return originalSend.call(this, data);
    };
  });
  await page.goto("/?nosup=1");

  const token = await readSessionToken(page);
  const createRes = await page.request.post(`/api/ptys/shell?token=${encodeURIComponent(token)}`);
  expect(createRes.ok()).toBeTruthy();
  const createJson = (await createRes.json()) as { id?: unknown };
  const ptyId = typeof createJson.id === "string" ? createJson.id : null;
  expect(ptyId).toBeTruthy();
  if (!ptyId) return;

  await expect(page.locator(`.mobile-session-card[data-pty-id="${ptyId}"]`)).toHaveCount(1, { timeout: 30_000 });
  await page.locator(`.mobile-session-card[data-pty-id="${ptyId}"]`).click();
  await expect(page.locator(".mobile-focus")).toHaveCount(1, { timeout: 10_000 });

  await page.reload();

  await expect(page.locator(".mobile-focus")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(".mobile-composer textarea")).toHaveCount(1, { timeout: 10_000 });

  await expect
    .poll(
      async () =>
        page.evaluate((id) => {
          const sent = ((window as any).__agmuxSentWs ?? []) as Array<{ type?: unknown; ptyId?: unknown }>;
          return sent.some((msg) => msg && msg.ptyId === id && msg.type === "resize");
        }, ptyId),
      { timeout: 15_000 },
    )
    .toBe(true);

  const textarea = page.locator(".mobile-composer textarea");
  await textarea.fill("echo mobile-refresh-ok");
  await page.locator(".mobile-send").click();
  await expect(textarea).toHaveValue("");

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("mobile-refresh-ok");

  await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
});

test("xterm viewport scrolls with mouse wheel", async ({ page }) => {
  await page.goto("/?nosup=1");

  // Clamp the terminal height so scrollback is guaranteed even on large screens.
  await page.addStyleTag({
    content: `
      .terminal-wrap { height: 260px !important; }
      #terminal { height: 240px !important; min-height: 240px !important; }
    `,
  });

  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  // Produce enough output to have scrollback.
  await page.evaluate((cmd) => (window as any).__agmux?.sendInput?.(cmd + "\r"), "for i in $(seq 1 500); do echo line-$i; done");

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("line-500");

  // Force to bottom, then wheel up and verify visible viewport changes.
  await page.evaluate(() => (window as any).__agmux?.scrollToBottomActive?.());
  const bottomViewport = await page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? "");

  await page.locator(".term-pane:not(.hidden) .xterm").hover();
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, -1000);
  }

  await expect
    .poll(async () => page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? ""), {
      timeout: 5_000,
    })
    .not.toBe(bottomViewport);

  // Cleanup (avoid leaking tmux sessions in e2e).
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (ptyId) {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("scroll up after cat reveals the cat command", async ({ page }) => {
  await page.goto("/?nosup=1");

  // Constrain the terminal height so scrollback is needed even with modest output.
  await page.addStyleTag({
    content: `
      .terminal-wrap { height: 260px !important; }
      #terminal { height: 240px !important; min-height: 240px !important; }
    `,
  });

  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const xterm = page.locator(".term-pane:not(.hidden) .xterm");

  // Create a file with enough lines to push the cat command off-screen,
  // but stay well within the 5000-line scrollback limit.
  await page.evaluate(
    (cmd) => (window as any).__agmux?.sendInput?.(cmd + "\r"),
    "seq 1 80 > /tmp/e2e-bigfile.txt && cat /tmp/e2e-bigfile.txt",
  );

  // Wait for cat output to finish — the shell prompt reappears after "80".
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toMatch(/\b80\n.*[#\$]/s);

  // At the bottom the cat command should be scrolled out of view.
  await page.evaluate(() => (window as any).__agmux?.scrollToBottomActive?.());

  // Scroll up with the mouse wheel to reveal the cat command.
  await xterm.hover();
  await page.mouse.wheel(0, -8000);

  await expect
    .poll(
      async () => page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? ""),
      { timeout: 5_000 },
    )
    .toMatch(/cat \/tmp\/e2e-bigfile\.t/i);

  // Cleanup.
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (ptyId) {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("clicking a history entry scrolls the terminal to that command", async ({ page }) => {
  await page.goto("/?nosup=1");

  // Constrain terminal height so a marker command scrolls out of view.
  await page.addStyleTag({
    content: `
      .terminal-wrap { height: 260px !important; }
      #terminal { height: 240px !important; min-height: 240px !important; }
    `,
  });

  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const dumpActive = () =>
    page.evaluate(() => {
      const d = (window as any).__agmux?.dumpActive;
      return typeof d === "function" ? String(d()) : "";
    });
  const dumpViewport = () =>
    page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? "");
  const sendInput = (cmd: string) =>
    page.evaluate((c) => (window as any).__agmux?.sendInput?.(c + "\r"), cmd);

  // Warm up so the marker prompt is past buffer line 0 (line 0 is never clickable).
  await sendInput("echo __warmup__");
  await expect.poll(dumpActive, { timeout: 10_000 }).toContain("__warmup__");

  // Marker command whose prompt position we later scroll back to.
  await sendInput("echo __scroll_target__");
  await expect.poll(dumpActive, { timeout: 10_000 }).toContain("__scroll_target__");

  // Push the marker off-screen with a burst of output.
  await sendInput("seq 1 120 > /tmp/e2e-history-scroll.txt && cat /tmp/e2e-history-scroll.txt");
  await expect.poll(dumpActive, { timeout: 30_000 }).toMatch(/\b120\b/);

  // At the bottom the marker is scrolled out of the visible viewport.
  await page.evaluate(() => (window as any).__agmux?.scrollToBottomActive?.());
  await expect.poll(dumpViewport, { timeout: 5_000 }).not.toContain("__scroll_target__");

  // Open the history dropdown and click the marker entry.
  await page.locator("#input-context-toggle").click();
  await expect(page.locator("#input-history-list")).not.toHaveClass(/hidden/, { timeout: 10_000 });
  const entry = page.locator("#input-history-list li", { hasText: "echo __scroll_target__" });
  await expect(entry).toHaveClass(/clickable/, { timeout: 10_000 });
  await entry.click();

  // Clicking drives tmux copy-mode to that command; the pane repaint streams
  // back and the marker becomes visible in the terminal viewport again.
  await expect.poll(dumpViewport, { timeout: 10_000 }).toContain("__scroll_target__");

  // Picking an entry dismissed the dropdown.
  await expect(page.locator("#input-history-list")).toHaveClass(/hidden/);

  // Clicking outside dismisses it too.
  await page.locator("#input-context-toggle").click();
  await expect(page.locator("#input-history-list")).not.toHaveClass(/hidden/);
  await page.locator("#terminal").click();
  await expect(page.locator("#input-history-list")).toHaveClass(/hidden/);

  // As does Escape.
  await page.locator("#input-context-toggle").click();
  await expect(page.locator("#input-history-list")).not.toHaveClass(/hidden/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#input-history-list")).toHaveClass(/hidden/);

  // Cleanup.
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (ptyId) {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("clicking an older duplicate history entry scrolls to its own occurrence", async ({ page }) => {
  await page.goto("/?nosup=1");

  await page.addStyleTag({
    content: `
      .terminal-wrap { height: 260px !important; }
      #terminal { height: 240px !important; min-height: 240px !important; }
    `,
  });

  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const dumpActive = () =>
    page.evaluate(() => {
      const d = (window as any).__agmux?.dumpActive;
      return typeof d === "function" ? String(d()) : "";
    });
  const dumpViewport = () =>
    page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? "");
  const sendInput = (cmd: string) =>
    page.evaluate((c) => (window as any).__agmux?.sendInput?.(c + "\r"), cmd);

  // A unique neighbor right above the first occurrence discriminates it.
  await sendInput("echo __before_first__");
  await expect.poll(dumpActive, { timeout: 10_000 }).toContain("__before_first__");

  // Same command runs twice, far apart in scrollback.
  await sendInput("echo __dup_target__");
  await expect.poll(dumpActive, { timeout: 10_000 }).toContain("__dup_target__");
  await sendInput("seq 1 120");
  await expect.poll(dumpActive, { timeout: 30_000 }).toMatch(/\b120\b/);
  await sendInput("echo __dup_target__");
  await sendInput("seq 1 40");
  await expect.poll(dumpActive, { timeout: 30_000 }).toMatch(/\b40\b/);

  await page.evaluate(() => (window as any).__agmux?.scrollToBottomActive?.());

  // Click the OLDER of the two identical entries.
  await page.locator("#input-context-toggle").click();
  await expect(page.locator("#input-history-list")).not.toHaveClass(/hidden/, { timeout: 10_000 });
  const entries = page.locator("#input-history-list li", { hasText: "echo __dup_target__" });
  await expect(entries).toHaveCount(2, { timeout: 10_000 });
  await entries.first().click();

  // Timestamp anchors must resolve to the first occurrence: its unique
  // neighbor is in view. A naive last-match search would land on the second.
  await expect.poll(dumpViewport, { timeout: 10_000 }).toContain("__before_first__");

  // Cleanup.
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (ptyId) {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("auto-attaches a live claude session and scrolls to a transcript prompt", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  test.skip(!hasTmux, "requires tmux");
  const logRoot = process.env.E2E_AGENT_LOG_ROOT;
  test.skip(!logRoot, "requires isolated agent log root");

  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
  const binDir = `/tmp/agmux-e2e-claude-bin-${suffix}`;
  const sessionId = `e2e-attach-${suffix}`;
  const logDir = path.join(logRoot!, "claude", "projects", "e2e");
  const logFile = path.join(logDir, `${sessionId}.jsonl`);
  const prompt = "Fix the widget frobnicator in the flux capacitor";
  let ptyId: string | null = null;

  // Fake claude: a symlink to sleep so process detection sees "claude".
  fs.mkdirSync(binDir, { recursive: true });
  await execFileAsync("ln", ["-sf", "/bin/sleep", `${binDir}/claude`]);

  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);

  await page.addStyleTag({
    content: `
      .terminal-wrap { height: 260px !important; }
      #terminal { height: 240px !important; min-height: 240px !important; }
    `,
  });

  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);
  ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));

  const dumpActive = () =>
    page.evaluate(() => {
      const d = (window as any).__agmux?.dumpActive;
      return typeof d === "function" ? String(d()) : "";
    });
  const dumpViewport = () =>
    page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? "");
  const sendInput = (cmd: string) =>
    page.evaluate((c) => (window as any).__agmux?.sendInput?.(c + "\r"), cmd);

  try {
    // Render the prompt echo the way Claude Code does, then push it off screen.
    await sendInput(`echo "❯ ${prompt}"`);
    await expect.poll(dumpActive, { timeout: 10_000 }).toContain(`❯ ${prompt}`);
    await sendInput("seq 1 120");
    await expect.poll(dumpActive, { timeout: 30_000 }).toMatch(/\b120\b/);

    // The fixture's cwd must equal the cwd the server tracks for this pty.
    const ptysRes = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`);
    const ptysJson = (await ptysRes.json()) as { ptys?: Array<{ id: string; cwd?: string | null }> };
    const cwd = ptysJson.ptys?.find((p) => p.id === ptyId)?.cwd;
    expect(cwd, "pty cwd should be known").toBeTruthy();

    // A live claude JSONL log for that cwd, containing the prompt.
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      logFile,
      JSON.stringify({
        type: "user",
        sessionId,
        cwd,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: prompt },
      }) + "\n",
      "utf8",
    );

    // Start the fake claude process; the sweep should now attach the session.
    await sendInput(`${binDir}/claude 300`);

    // The dropdown switches to transcript history: exactly the one prompt.
    await page.locator("#input-context-toggle").click();
    await expect(page.locator("#input-history-list")).not.toHaveClass(/hidden/, { timeout: 10_000 });
    const entry = page.locator("#input-history-list li", { hasText: "widget frobnicator" });
    await expect(entry).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator("#input-history-label")).toHaveText("History (1)", { timeout: 10_000 });

    // From the bottom the echo is out of view; clicking the transcript entry
    // brings it back.
    await page.evaluate(() => (window as any).__agmux?.scrollToBottomActive?.());
    await expect.poll(dumpViewport, { timeout: 5_000 }).not.toContain("❯ Fix the widget");
    await entry.click();
    await expect.poll(dumpViewport, { timeout: 10_000 }).toContain(`❯ ${prompt}`);
  } finally {
    if (ptyId) {
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(logFile, { force: true });
  }
});

test("pty list shows running subprocess name", async ({ page }) => {
  await page.goto("/?nosup=1");
  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  try {
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type("sleep 8");
    await page.keyboard.press("Enter");

    await expect(page.locator(".pty-item.active .ready-dot:not(.compact).busy")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".pty-item.active .secondary")).toContainText("> sleep 8", { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("PR menu shows active PR details and acknowledges attention after rendering", async ({ page }) => {
  const viewedPayloads: unknown[] = [];
  await page.route((url) => url.pathname === "/api/azure-pr/menu", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        supported: true,
        projectRoot: "/home/rutger/agmux",
        fetchedAt: Date.now(),
        prs: [
          {
            id: 4812,
            title: "Improve launch flow",
            author: "Rutger Prins",
            isOwnAuthor: true,
            isDraft: false,
            sourceBranch: "feature/launch-flow",
            targetBranch: "main",
            createdAt: Date.now() - 86_400_000,
            updatedAt: Date.now() - 7_200_000,
            headSha: "abc123",
            url: "https://dev.azure.com/example/project/_git/repo/pullrequest/4812?_a=files",
            worktree: { name: "launch-flow", path: "/repo-launch-flow", dirty: true },
            attention: "published",
          },
          {
            id: 4809,
            title: "Try the new scanner",
            author: "Alex Reviewer",
            isDraft: true,
            sourceBranch: "feature/scanner",
            targetBranch: "main",
            createdAt: Date.now() - 3_600_000,
            updatedAt: Date.now() - 3_600_000,
            headSha: "def456",
            url: "https://dev.azure.com/example/project/_git/repo/pullrequest/4809?_a=files",
            worktree: null,
            attention: "new",
          },
          {
            id: 4801,
            title: "Refresh deployment docs",
            author: "Sam Developer",
            isDraft: false,
            sourceBranch: "docs/deployment",
            targetBranch: "main",
            createdAt: Date.now() - 10 * 86_400_000,
            updatedAt: Date.now() - 4 * 86_400_000,
            headSha: "ghi789",
            url: "https://dev.azure.com/example/project/_git/repo/pullrequest/4801?_a=files",
            worktree: null,
            attention: null,
          },
        ],
      }),
    });
  });
  await page.route((url) => url.pathname === "/api/azure-pr/menu/viewed", async (route) => {
    viewedPayloads.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/?nosup=1");
  await newShellSession(page);

  const prButton = page.getByRole("button", { name: /Pull requests for agmux/ });
  await expect(prButton).toBeVisible();
  await expect(prButton).toHaveCSS("opacity", "0.7");
  await expect(prButton.locator(".pr-menu-attention-dot")).toHaveCount(1);
  await prButton.click();

  const modal = page.getByRole("dialog", { name: "Pull requests for agmux" });
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute("aria-modal", "true");
  const modalBox = await modal.boundingBox();
  const viewport = page.viewportSize();
  expect(modalBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!modalBox || !viewport) throw new Error("PR modal geometry is unavailable");
  expect(Math.abs(modalBox.x + modalBox.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(modalBox.y + modalBox.height / 2 - viewport.height / 2)).toBeLessThan(2);
  const table = modal.getByRole("table", { name: "Active pull requests" });
  await expect(table).toBeVisible();
  await expect(modal.locator(".pr-menu-table-scroll")).toHaveCSS("margin", "12px");
  for (const heading of ["Title", "Author", "State", "Source branch", "Worktree", "Updated"]) {
    await expect(table.getByRole("columnheader", { name: heading })).toBeVisible();
  }
  const publishedRow = table.getByRole("row", { name: /PR 4812: Improve launch flow/ });
  await expect(publishedRow.getByRole("cell", { name: "Rutger Prins" })).toBeVisible();
  await expect(publishedRow.getByRole("cell", { name: "Active" })).toBeVisible();
  await expect(publishedRow.locator(".pr-menu-author.own")).toContainText("Rutger Prins");
  await expect(publishedRow.getByText("You", { exact: true })).toBeVisible();
  const draftRow = table.getByRole("row", { name: /PR 4809: Try the new scanner/ });
  await expect(draftRow.getByRole("cell", { name: "Alex Reviewer" })).toBeVisible();
  await expect(draftRow.getByRole("cell", { name: "Draft" })).toBeVisible();
  const draftColor = await draftRow.getByText("Draft", { exact: true }).evaluate((el) => getComputedStyle(el).color);
  const publishedColor = await publishedRow.getByText("Active", { exact: true })
    .evaluate((el) => getComputedStyle(el).color);
  const mutedColor = await draftRow.locator(".pr-menu-author").evaluate((el) => getComputedStyle(el).color);
  expect(draftColor).not.toBe(publishedColor);
  expect(draftColor).not.toBe(mutedColor);
  expect(publishedColor).not.toBe(mutedColor);
  const staleRow = table.getByRole("row", { name: /PR 4801: Refresh deployment docs/ });
  await expect(staleRow).toHaveClass(/stale/);
  const staleTitleColor = await staleRow.locator(".pr-menu-title").evaluate((el) => getComputedStyle(el).color);
  const staleStateColor = await staleRow.locator(".pr-menu-state .active").evaluate((el) => getComputedStyle(el).color);
  expect(staleTitleColor).toBe(mutedColor);
  expect(staleStateColor).toBe(mutedColor);
  await expect(modal.getByText("Improve launch flow")).toBeVisible();
  await expect(modal.getByText("Rutger Prins")).toBeVisible();
  await expect(modal.getByText("feature/launch-flow")).toBeVisible();
  await expect(modal.getByText("Worktree: launch-flow", { exact: true })).toHaveCount(0);
  await expect(publishedRow.getByText("launch-flow", { exact: true })).toBeVisible();
  await expect(modal.getByText("dirty")).toBeVisible();
  await expect(modal.getByText("Published")).toBeVisible();
  await expect(modal.getByText("Try the new scanner")).toBeVisible();
  await expect(modal.getByText("Draft")).toBeVisible();
  await expect(modal.getByText("New", { exact: true })).toBeVisible();
  await expect(modal.getByRole("button", { name: "Launch agent on PR 4812" })).toBeVisible();
  await expect(modal.getByRole("link", { name: /PR 4812: Improve launch flow/ })).toHaveAttribute(
    "href",
    /pullrequest\/4812/,
  );
  await expect(modal.getByRole("link", { name: /PR 4812: Improve launch flow/ })).toHaveAttribute(
    "title",
    "Improve launch flow",
  );
  await expect.poll(() => viewedPayloads.length).toBe(1);
  await expect(prButton.locator(".pr-menu-attention-dot")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await prButton.click();
  await expect(modal.getByText("Published", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("New", { exact: true })).toHaveCount(0);
  await page.locator(".pr-menu-overlay").click({ position: { x: 5, y: 5 } });
  await expect(modal).not.toBeVisible();
});

test("PR launch context checks out the source branch and can start the review flow", async ({ page }) => {
  const launchPayloads: Array<Record<string, unknown>> = [];
  let activePtyId = "";
  await page.route((url) => url.pathname === "/api/azure-pr/menu", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        supported: true,
        projectRoot: "/home/rutger/agmux",
        fetchedAt: Date.now(),
        prs: [
          {
            id: 4812,
            title: "Improve launch flow",
            author: "Rutger Prins",
            isDraft: false,
            sourceBranch: "feature/launch-flow",
            targetBranch: "main",
            createdAt: Date.now() - 86_400_000,
            updatedAt: Date.now() - 7_200_000,
            headSha: "abc123",
            url: "https://dev.azure.com/example/project/_git/repo/pullrequest/4812?_a=files",
            worktree: { name: "launch-flow", path: "/repo-launch-flow", dirty: true },
            attention: null,
          },
          {
            id: 4809,
            title: "Try the new scanner",
            author: "Alex Reviewer",
            isDraft: true,
            sourceBranch: "feature/scanner",
            targetBranch: "main",
            createdAt: Date.now() - 3_600_000,
            updatedAt: Date.now() - 3_600_000,
            headSha: "def456",
            url: "https://dev.azure.com/example/project/_git/repo/pullrequest/4809?_a=files",
            worktree: null,
            attention: null,
          },
        ],
      }),
    });
  });
  await page.route((url) => url.pathname === "/api/ptys/launch", async (route) => {
    launchPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ id: activePtyId }),
    });
  });

  await page.goto("/?nosup=1");
  await newShellSession(page);
  activePtyId = await page.locator(".pty-item.active").getAttribute("data-pty-id") ?? "";

  await page.locator(".group-launch").first().click();
  const ordinaryLaunch = page.getByRole("dialog", { name: /Launch agent/ });
  await expect(ordinaryLaunch.getByRole("button", { name: "Launch Review" })).toHaveCount(0);
  await ordinaryLaunch.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: /Pull requests for agmux/ }).click();
  await page.getByRole("button", { name: "Launch agent on PR 4809" }).click();

  const prLaunch = page.getByRole("dialog", { name: /Launch agent/ });
  await expect(prLaunch.getByText("PR #4809", { exact: true })).toBeVisible();
  await expect(prLaunch.getByText("feature/scanner", { exact: true })).toBeVisible();
  await expect(prLaunch.getByText("Create worktree: feature/scanner", { exact: true })).toBeVisible();
  await expect(prLaunch.getByRole("button", { name: "Launch", exact: true })).toBeVisible();
  await prLaunch.getByRole("button", { name: "Launch Review" }).click();

  await expect.poll(() => launchPayloads.length).toBe(1);
  expect(launchPayloads[0]).toMatchObject({
    worktree: "__new__",
    branch: "feature/scanner",
    baseBranch: "origin/feature/scanner",
    refreshRemoteBase: true,
    initialInput: "/review-pr 4809",
    name: "PR #4809: Try the new scanner",
  });

  await page.getByRole("button", { name: /Pull requests for agmux/ }).click();
  await page.getByRole("button", { name: "Launch agent on PR 4812" }).click();
  const existingWorktreeLaunch = page.getByRole("dialog", { name: /Launch agent/ });
  await expect(existingWorktreeLaunch.getByText("Use worktree: launch-flow", { exact: true })).toBeVisible();
  await existingWorktreeLaunch.getByRole("button", { name: "Launch", exact: true }).click();

  await expect.poll(() => launchPayloads.length).toBe(2);
  expect(launchPayloads[1]).toMatchObject({
    worktree: "/repo-launch-flow",
    refreshRemoteBase: false,
    name: "PR #4812: Improve launch flow",
  });
  expect(launchPayloads[1]).not.toHaveProperty("branch");
  expect(launchPayloads[1]).not.toHaveProperty("baseBranch");
  expect(launchPayloads[1]).not.toHaveProperty("initialInput");
});

test("pty list item shows current working directory", async ({ page }) => {
  await page.goto("/?nosup=1");
  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  const token = await readSessionToken(page);

  try {
    const active = page.locator(".pty-item.active");

    // cd to /tmp and verify grouping updates to the new cwd bucket.
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type("cd /tmp");
    await page.keyboard.press("Enter");

    const groupHeader = page.locator("#pty-list .pty-group-header").first();
    await expect(groupHeader).toContainText("tmp", { timeout: 10_000 });
    await expect(groupHeader).toHaveAttribute("title", /\/tmp/, { timeout: 10_000 });
  } finally {
    if (ptyId) {
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("pty readiness flips busy to ready around subprocess execution", async ({ page }) => {
  await page.goto("/?nosup=1");
  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  try {
    const active = page.locator(".pty-item.active");
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type("sleep 1");
    await page.keyboard.press("Enter");

    await expect(active.locator(".ready-dot:not(.compact).busy")).toHaveCount(1, { timeout: 5_000 });
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("pty readiness settles back to ready for immediate prompt commands", async ({ page }) => {
  await page.goto("/?nosup=1");
  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  try {
    const active = page.locator(".pty-item.active");
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

    await page.keyboard.type(":");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("pty readiness flips to busy during sustained output", async ({ page }) => {
  await page.goto("/?nosup=1");
  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  try {
    const active = page.locator(".pty-item.active");
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

    await page.keyboard.type("for i in $(seq 1 50); do echo $i; sleep 0.1; done");
    await page.keyboard.press("Enter");

    await expect(active.locator(".ready-dot:not(.compact).busy")).toHaveCount(1, { timeout: 8_000 });
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 20_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("tmux non-shell interactive prompt stays ready after reload", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  const hasPython = await commandAvailable("python3", ["--version"]);
  test.skip(!hasTmux || !hasPython, "requires tmux and python3");

  const sessionName = `agmux_e2e_prompt_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let ptyId: string | null = null;

  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "python3", "-q"]);

  try {
    await page.goto("/?nosup=1");
    const token = await readSessionToken(page);
    ptyId = await attachTmuxWithRetry(page, token, sessionName);

    const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(item).toHaveCount(1, { timeout: 10_000 });
    await expect(item.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

    // Keep this above the server prompt window to catch stale busy regressions.
    await page.waitForTimeout(16_000);
    await expect(item.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

    await page.reload();
    const reloadedItem = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(reloadedItem).toHaveCount(1, { timeout: 10_000 });
    await expect(reloadedItem.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
  }
});

test("tmux non-shell prompt with footer line stays stable", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  const hasPython = await commandAvailable("python3", ["--version"]);
  test.skip(!hasTmux || !hasPython, "requires tmux and python3");

  const sessionName = `agmux_e2e_footer_prompt_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let ptyId: string | null = null;

  const script =
    "import sys,time; print('› Ask anything'); print('  100% context left'); sys.stdout.flush(); " +
    "[(sys.stdout.write('\\\\x1b[?25l\\\\x1b[?25h'), sys.stdout.flush(), time.sleep(0.05)) for _ in range(320)]; input()";
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "python3", "-u", "-c", script]);

  try {
    await page.goto("/?nosup=1");
    const token = await readSessionToken(page);
    ptyId = await attachTmuxWithRetry(page, token, sessionName);

    const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(item).toHaveCount(1, { timeout: 10_000 });
    await expect
      .poll(async () => {
        const stable = await page
          .locator(
            `.pty-item[data-pty-id="${ptyId}"] [aria-label="PTY is ready"], ` +
            `.pty-item[data-pty-id="${ptyId}"] [aria-label="PTY is unknown"]`,
          )
          .count();
        return stable;
      }, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Keep this above the server prompt window; we only require the PTY row remains present.
    await page.waitForTimeout(16_000);
    await expect(item).toHaveCount(1, { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
  }
});

test("tmux claude/codex subprocess prompt uses prompt readiness detection", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  const hasPython = await commandAvailable("python3", ["--version"]);
  test.skip(!hasTmux || !hasPython, "requires tmux and python3");

  const pythonExecRes = await execFileAsync("python3", ["-c", "import sys; print(sys.executable)"]);
  const pythonExec = pythonExecRes.stdout.trim();
  if (!pythonExec) throw new Error("could not resolve python3 executable path");

  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);

  for (const family of ["codex", "claude"] as const) {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const sessionName = `agmux_e2e_${family}_prompt_${suffix}`;
    const binaryPath = `/tmp/${family}-e2e-prompt-${suffix}`;
    const promptLine = family === "codex" ? "› Ask anything" : "❯ Ask anything";
    const script = `import sys,time; print(${JSON.stringify(promptLine)}); sys.stdout.flush(); time.sleep(20)`;
    let ptyId: string | null = null;

    await execFileAsync("ln", ["-sf", pythonExec, binaryPath]);
    await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, binaryPath, "-u", "-c", script]);

    try {
      ptyId = await attachTmuxWithRetry(page, token, sessionName);

      const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
      await expect(item).toHaveCount(1, { timeout: 10_000 });
      await expect(item.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 12_000 });
    } finally {
      if (ptyId) {
        await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
      }
      await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
      await execFileAsync("rm", ["-f", binaryPath]).catch(() => {});
    }
  }
});

test("tmux node-wrapped codex command shows codex as active process", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  const hasNode = await commandAvailable("node", ["--version"]);
  test.skip(!hasTmux || !hasNode, "requires tmux and node");

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const sessionName = `agmux_e2e_codex_node_${suffix}`;
  const scriptPath = `/tmp/codex-e2e-${suffix}.js`;
  // Use a symlink named "codex-..." so the process name contains "codex".
  const symlinkPath = `/tmp/codex-e2e-node-${suffix}`;
  let ptyId: string | null = null;

  const nodeExecRes = await execFileAsync("which", ["node"]);
  const nodePath = nodeExecRes.stdout.trim();
  if (!nodePath) throw new Error("could not resolve node executable path");

  fs.writeFileSync(scriptPath, "setTimeout(() => process.exit(0), 20000);\n", "utf8");
  await execFileAsync("ln", ["-sf", nodePath, symlinkPath]);
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, symlinkPath, scriptPath]);

  try {
    await page.goto("/?nosup=1");
    const token = await readSessionToken(page);
    ptyId = await attachTmuxWithRetry(page, token, sessionName);

    const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(item).toHaveCount(1, { timeout: 10_000 });
    await expect(item.locator(".primary")).toContainText("codex", { timeout: 12_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
    await execFileAsync("rm", ["-f", scriptPath, symlinkPath]).catch(() => {});
  }
});

test("escape key is delivered to tmux session promptly", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  test.skip(!hasTmux, "requires tmux");

  const sessionName = `agmux_e2e_esc_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let ptyId: string | null = null;

  // Create a tmux session running cat -v, which echoes Escape as ^[.
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "cat", "-v"]);

  try {
    await page.goto("/?nosup=1");
    const token = await readSessionToken(page);
    // Attaching applies tmuxApplySessionUiOptions which sets escape-time 10ms.
    ptyId = await attachTmuxWithRetry(page, token, sessionName);

    const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(item).toHaveCount(1, { timeout: 10_000 });
    await item.click();

    // Wait for the terminal to be ready.
    await page.waitForTimeout(500);
    const xterm = page.locator(".term-pane:not(.hidden) .xterm");
    await xterm.click();

    // Press Escape — cat -v should echo ^[.
    await page.keyboard.press("Escape");

    // ^[ must appear within 2s (with 500ms escape-time it would be delayed,
    // but with 10ms it should appear almost instantly).
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const d = (window as any).__agmux?.dumpActive;
            return typeof d === "function" ? String(d()) : "";
          }),
        { timeout: 5_000 },
      )
      .toContain("^[");
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
  }
});

test("reopening running tmux PTY after refresh shows output without wheel scroll", async ({ page }) => {
  await page.goto("/?nosup=1");
  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  const token = await readSessionToken(page);
  const ptysRes = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`);
  const ptysJson = (await ptysRes.json()) as { ptys?: Array<{ id?: string; backend?: string }> };
  const backend = ptysJson.ptys?.find((p) => p.id === ptyId)?.backend;
  test.skip(backend !== "tmux", "requires tmux backend");

  const marker = "__refresh-visible-marker__";

  try {
    const xterm = page.locator(".term-pane:not(.hidden) .xterm");
    await xterm.click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const d = (window as any).__agmux?.dumpActive;
            return typeof d === "function" ? String(d()) : "";
          }),
        { timeout: 30_000 },
      )
      .toContain(marker);

    await page.reload();
    await page.locator(`.pty-item[data-pty-id="${ptyId}"]`).click();

    await expect
      .poll(
        async () => page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? ""),
        { timeout: 10_000 },
      )
      .toContain(marker);
  } finally {
    if (ptyId) {
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("each browser tab restores its own active PTY after reload", async ({ page }) => {
  let page2: Page | null = null;
  let firstTabPtyId: string | null = null;
  let secondTabPtyId: string | null = null;
  const token = await readSessionToken(page);

  try {
    await page.goto("/?nosup=1");
    page2 = await page.context().newPage();
    await page2.addInitScript((t: string) => {
      sessionStorage.setItem("agmux:authToken", t);
    }, token);
    await page2.goto("/?nosup=1");

    await newShellSession(page);
    await expect(page.locator(".pty-item.active")).toHaveCount(1);
    firstTabPtyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    if (!firstTabPtyId) throw new Error("missing first tab PTY id");

    await newShellSession(page2);
    await expect(page2.locator(".pty-item.active")).toHaveCount(1);
    secondTabPtyId = await page2.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    if (!secondTabPtyId) throw new Error("missing second tab PTY id");
    expect(secondTabPtyId).not.toBe(firstTabPtyId);

    await expect(page.locator(`.pty-item[data-pty-id="${firstTabPtyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
    await expect(page2.locator(`.pty-item[data-pty-id="${secondTabPtyId}"].active`)).toHaveCount(1, { timeout: 10_000 });

    await page.reload();
    await page2.reload();

    await expect(page.locator(`.pty-item[data-pty-id="${firstTabPtyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
    await expect(page2.locator(`.pty-item[data-pty-id="${secondTabPtyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
  } finally {
    if (firstTabPtyId) await killPty(page, token, firstTabPtyId);
    if (secondTabPtyId && secondTabPtyId !== firstTabPtyId) await killPty(page, token, secondTabPtyId);
    if (page2) await page2.close();
  }
});

test("ready PTY keeps last input visible after reload", async ({ page }) => {
  await page.goto("/?nosup=1");
  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const marker = "__last_input_ready__";
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (!ptyId) throw new Error("missing PTY id");

  try {
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");

    const activeSecondary = page.locator(".pty-item.active .secondary");
    await expect(activeSecondary).toContainText(`> echo ${marker}`, { timeout: 10_000 });
    await expect(page.locator(".pty-item.active .ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

    await page.reload();

    await expect(page.locator(`.pty-item[data-pty-id="${ptyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(`.pty-item[data-pty-id="${ptyId}"] .secondary`)).toContainText(`> echo ${marker}`, {
      timeout: 10_000,
    });
  } finally {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("input context bar keeps recent history visible across PTY switches", async ({ page }) => {
  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);
  let ptyOne: string | null = null;
  let ptyTwo: string | null = null;

  try {
    await killAllRunningPtys(page, token);

    await newShellSession(page);
    await expect(page.locator(".pty-item.active")).toHaveCount(1);
    ptyOne = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    if (!ptyOne) throw new Error("missing PTY one id");

    await page.locator(`.pty-item[data-pty-id="${ptyOne}"]`).click();
    const ptyOneXterm = page.locator(`.term-pane[data-pty-id="${ptyOne}"]:not(.hidden) .xterm`);
    await expect(ptyOneXterm).toBeVisible({ timeout: 10_000 });

    const dumpActive = () =>
      page.evaluate(() => {
        const d = (window as any).__agmux?.dumpActive;
        return typeof d === "function" ? String(d()) : "";
      });

    await page.evaluate((cmd) => (window as any).__agmux?.sendInput?.(cmd + "\r"), "echo __ctx_pty_one__");

    // Wait for first command output before sending second command.
    await expect.poll(dumpActive, { timeout: 10_000 }).toContain("__ctx_pty_one__");

    await page.evaluate((cmd) => (window as any).__agmux?.sendInput?.(cmd + "\r"), "pwd");

    // Wait for pwd output before checking input context.
    await expect.poll(dumpActive, { timeout: 10_000 }).toMatch(/\/(home|tmp|usr|root)[^\n]*/);

    await expect(page.locator("#input-context")).not.toHaveClass(/hidden/, { timeout: 10_000 });
    await expect(page.locator("#input-context-last")).toContainText("pwd", { timeout: 10_000 });
    await expect(page.locator("#input-history-label")).toHaveText(/History \(\d+\)/, { timeout: 10_000 });

    await page.locator("#input-context-toggle").click();
    await expect(page.locator("#input-history-list")).not.toHaveClass(/hidden/, { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).toContainText("pwd", { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).toContainText("echo __ctx_pty_one__", { timeout: 10_000 });

    await newShellSession(page);
    await expect(page.locator(".pty-item.active")).toHaveCount(1);
    ptyTwo = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    if (!ptyTwo) throw new Error("missing PTY two id");

    await page.locator(`.pty-item[data-pty-id="${ptyTwo}"]`).click();
    const ptyTwoXterm = page.locator(`.term-pane[data-pty-id="${ptyTwo}"]:not(.hidden) .xterm`);
    await expect(ptyTwoXterm).toBeVisible({ timeout: 10_000 });

    await page.evaluate((cmd) => (window as any).__agmux?.sendInput?.(cmd + "\r"), "echo __ctx_pty_two__");

    await expect(page.locator("#input-context-last")).toContainText("echo __ctx_pty_two__", { timeout: 10_000 });
    await expect(page.locator("#input-history-label")).toHaveText(/History \(\d+\)/, { timeout: 10_000 });
    // The dropdown auto-closed when clicking elsewhere; reopen to inspect it.
    await page.locator("#input-context-toggle").click();
    await expect(page.locator("#input-history-list")).toContainText("echo __ctx_pty_two__", { timeout: 10_000 });

    await page.locator(`.pty-item[data-pty-id="${ptyOne}"]`).click();
    await expect(page.locator("#input-context-last")).toHaveText(/pwd|echo __ctx_pty_two__/, { timeout: 10_000 });
    await expect(page.locator("#input-history-label")).toHaveText(/History \(\d+\)/, { timeout: 10_000 });
    await page.locator("#input-context-toggle").click();
    await expect(page.locator("#input-history-list")).toContainText("echo __ctx_pty_one__", { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).toContainText("echo __ctx_pty_two__", { timeout: 10_000 });
  } finally {
    if (ptyOne) {
      await killPty(page, token, ptyOne);
    }
    if (ptyTwo && ptyTwo !== ptyOne) {
      await killPty(page, token, ptyTwo);
    }
  }
});

test("switching between multiple PTYs keeps each terminal's content distinct", async ({ page }) => {
  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);

  const ptys: Array<{ id: string; marker: string }> = [];
  const markerById = new Map<string, string>();
  const markers = ["__switch_pty_one__", "__switch_pty_two__", "__switch_pty_three__"];

  const readActivePtyId = async (): Promise<string | null> =>
    page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));

  const dumpActiveBuffer = async (): Promise<string> =>
    page.evaluate(() => {
      const dump = (window as any).__agmux?.dumpActive;
      return typeof dump === "function" ? String(dump()) : "";
    });

  const assertActiveHasOwnMarkerOnly = async (ptyId: string): Promise<void> => {
    const marker = markerById.get(ptyId);
    if (!marker) throw new Error(`missing marker for PTY ${ptyId}`);
    const otherMarkers = ptys.filter((p) => p.id !== ptyId).map((p) => p.marker);

    await expect(page.locator(`.pty-item[data-pty-id="${ptyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
    await expect
      .poll(
        async () => {
          const buffer = await dumpActiveBuffer();
          return buffer.includes(marker) && otherMarkers.every((m) => !buffer.includes(m));
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  };

  try {
    await killAllRunningPtys(page, token);

    for (const marker of markers) {
      const prevActivePtyId = ptys.length > 0 ? ptys[ptys.length - 1].id : null;
      await newShellSession(page);
      await expect(page.locator(".pty-item.active")).toHaveCount(1);
      if (prevActivePtyId) {
        await expect.poll(readActivePtyId, { timeout: 10_000 }).not.toBe(prevActivePtyId);
      }

      const ptyId = await readActivePtyId();
      if (!ptyId) throw new Error("missing PTY id");
      expect(ptys.map((p) => p.id)).not.toContain(ptyId);

      ptys.push({ id: ptyId, marker });
      markerById.set(ptyId, marker);

      const xterm = page.locator(`.term-pane[data-pty-id="${ptyId}"]:not(.hidden) .xterm`);
      await expect(xterm).toBeVisible({ timeout: 10_000 });
      await xterm.click({ force: true });
      await page.keyboard.type(`echo ${marker}`);
      await page.keyboard.press("Enter");

      await assertActiveHasOwnMarkerOnly(ptyId);
    }

    const firstPtyId = ptys[0]?.id;
    const lastPtyId = ptys[2]?.id;
    if (!firstPtyId || !lastPtyId) throw new Error("expected three PTYs");

    await page.locator(`.pty-item[data-pty-id="${firstPtyId}"]`).click();
    await assertActiveHasOwnMarkerOnly(firstPtyId);

    await page.keyboard.press("Control+Shift+BracketRight");
    await expect.poll(readActivePtyId, { timeout: 10_000 }).not.toBe(firstPtyId);

    const switchedPtyId = await readActivePtyId();
    if (!switchedPtyId) throw new Error("missing switched PTY id");
    await assertActiveHasOwnMarkerOnly(switchedPtyId);

    await page.keyboard.press("Control+Shift+BracketLeft");
    await expect.poll(readActivePtyId, { timeout: 10_000 }).toBe(firstPtyId);
    await assertActiveHasOwnMarkerOnly(firstPtyId);

    await page.locator(`.pty-item[data-pty-id="${lastPtyId}"]`).click();
    await assertActiveHasOwnMarkerOnly(lastPtyId);
  } finally {
    for (const p of ptys) {
      await killPty(page, token, p.id);
    }
  }
});

test("OSC window title appears in sidebar secondary text", async ({ page }) => {
  await page.goto("/?nosup=1");
  await newShellSession(page);
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (!ptyId) throw new Error("missing PTY id");

  try {
    await page.locator(".term-pane:not(.hidden) .xterm").click();

    // Send an OSC 0 (set window title) escape sequence.
    const title = "__e2e_window_title__";
    await page.keyboard.type(`printf '\\033]0;${title}\\007'`);
    await page.keyboard.press("Enter");

    // The title should appear in the sidebar item's secondary text (or title-label).
    const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(item).toContainText(title, { timeout: 10_000 });
  } finally {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("switching same-name tmux sessions across servers keeps PTYs distinct", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  test.skip(!hasTmux, "requires tmux");

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const sessionName = `agmux_e2e_same_name_${suffix}`;
  const defaultValue = `default:${sessionName}`;
  const agmuxValue = `agmux:${sessionName}`;

  let defaultPtyId: string | null = null;
  let agmuxPtyId: string | null = null;

  page.on("dialog", (dialog) => {
    void dialog.accept();
  });

  const tmuxSocket = process.env.AGMUX_TMUX_SOCKET ?? "agmux";
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "sh", "-lc", "echo default-server; exec cat"]);
  await execFileAsync("tmux", ["-L", tmuxSocket, "-f", "/dev/null", "new-session", "-d", "-s", sessionName, "sh", "-lc", "echo agmux-server; exec cat"]);

  try {
    await page.goto("/?nosup=1");
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.locator(".launch-modal h3")).toContainText("Settings");

    await page.locator("#tmux-session-select").focus();
    await expect(page.locator(`#tmux-session-select option[value="${defaultValue}"]`)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(`#tmux-session-select option[value="${agmuxValue}"]`)).toHaveCount(1, { timeout: 10_000 });

    await page.selectOption("#tmux-session-select", defaultValue);
    await expect(page.locator(".pty-item.active")).toHaveCount(1, { timeout: 10_000 });
    defaultPtyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    expect(defaultPtyId).toBeTruthy();

    await page.selectOption("#tmux-session-select", agmuxValue);
    await expect
      .poll(
        async () => page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id")),
        { timeout: 10_000 },
      )
      .not.toBe(defaultPtyId);

    agmuxPtyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    expect(agmuxPtyId).toBeTruthy();
    expect(agmuxPtyId).not.toBe(defaultPtyId);

    await expect(page.locator(`.pty-item[data-pty-id="${defaultPtyId}"]`)).toHaveCount(1);
    await expect(page.locator(`.pty-item[data-pty-id="${agmuxPtyId}"]`)).toHaveCount(1);

    const token = await readSessionToken(page);
    const listRes = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`);
    expect(listRes.ok()).toBe(true);
    const listJson = (await listRes.json()) as {
      ptys?: Array<{ id?: unknown; backend?: unknown; tmuxSession?: unknown; tmuxServer?: unknown; status?: unknown }>;
    };

    const sameNameRunning = (listJson.ptys ?? []).filter(
      (p) =>
        p?.backend === "tmux" &&
        p?.status === "running" &&
        p?.tmuxSession === sessionName,
    );

    expect(sameNameRunning.length).toBe(2);
    const servers = sameNameRunning
      .map((p) => (typeof p.tmuxServer === "string" ? p.tmuxServer : ""))
      .sort();
    expect(servers).toEqual(["agmux", "default"]);
  } finally {
    const token = await readSessionToken(page).catch(() => "");
    if (token && defaultPtyId) await killPty(page, token, defaultPtyId);
    if (token && agmuxPtyId) await killPty(page, token, agmuxPtyId);

    await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
    await execFileAsync("tmux", ["-L", "agmux", "-f", "/dev/null", "kill-session", "-t", sessionName]).catch(() => {});
  }
});

test("settings modal opens, saves worktree template, and persists", async ({ page }) => {
  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);

  // Open settings modal
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".launch-modal h3")).toContainText("Settings");

  // Verify default template field is empty (placeholder shows default)
  const templateInput = page.locator(".launch-modal input[type='text']").first();
  await expect(templateInput).toHaveValue("");

  // Set a custom template
  await templateInput.fill("../{repo-name}-custom-{branch}");

  // Save
  await page.locator(".launch-modal-go").click();

  // Modal should close
  await expect(page.locator(".launch-modal")).toHaveCount(0, { timeout: 5_000 });

  // Verify via API that template was saved
  const res = await page.request.get(`/api/settings?token=${encodeURIComponent(token)}`);
  const settings = await res.json();
  expect(settings.worktreePathTemplate).toBe("../{repo-name}-custom-{branch}");

  // Reset via API for test cleanup
  await page.request.put(`/api/settings?token=${encodeURIComponent(token)}`, {
    data: { worktreePathTemplate: null },
  });
});

test("settings modal creates, reorders, and persists Claude model presets", async ({ page }) => {
  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);

  try {
    await page.getByRole("button", { name: "Settings" }).click();
    const presetsGroup = page.getByRole("group", { name: "Claude model presets" });
    await expect(presetsGroup).toBeVisible();
    await expect(presetsGroup).toContainText("Ctrl+Shift+M");
    await expect(page.getByText("No Claude presets configured.")).toBeVisible();

    await page.getByRole("button", { name: "Add Claude preset" }).click();
    await page.getByLabel("Preset 1 name").fill("Fast");
    await page.getByLabel("Preset 1 model").fill("sonnet");
    await page.getByLabel("Preset 1 effort").selectOption("low");

    await page.getByRole("button", { name: "Add Claude preset" }).click();
    await page.getByLabel("Preset 2 name").fill("Deep review");
    await page.getByLabel("Preset 2 model").fill("claude-opus-4-7");
    await page.getByLabel("Preset 2 effort").selectOption("xhigh");
    await page.getByRole("button", { name: "Move preset 2 up" }).click();

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".launch-modal")).toHaveCount(0);

    const response = await page.request.get(`/api/settings?token=${encodeURIComponent(token)}`);
    const settings = await response.json();
    expect(settings.claudeModelPresets).toEqual([
      expect.objectContaining({ name: "Deep review", model: "claude-opus-4-7", effort: "xhigh" }),
      expect.objectContaining({ name: "Fast", model: "sonnet", effort: "low" }),
    ]);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByLabel("Preset 1 name")).toHaveValue("Deep review");
    await expect(page.getByLabel("Preset 2 name")).toHaveValue("Fast");
  } finally {
    await page.request.put(`/api/settings?token=${encodeURIComponent(token)}`, {
      data: { claudeModelPresets: [] },
    });
  }
});

test("keybindings popup captures, persists, rejects duplicates, and resets shortcuts", async ({ page }) => {
  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);
  const app = page.locator("#app");

  try {
    const keybindingsTrigger = page.getByTitle("Keybindings");
    await keybindingsTrigger.click();
    const popup = page.getByRole("dialog", { name: "Keybindings" });
    await expect(popup).toBeVisible();
    await expect(popup.getByRole("button", { name: "Change shortcut for New shell" })).toBeFocused();

    const toggleBinding = popup.getByRole("button", { name: "Change shortcut for Toggle sidebar" });
    await toggleBinding.click();
    await expect(toggleBinding).toContainText("Press shortcut");
    await page.keyboard.press("Alt+Shift+KeyB");
    await expect(toggleBinding).toContainText("Alt+Shift+B");

    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(keybindingsTrigger).toBeFocused();
    await expect(app).not.toHaveClass(/sidebar-collapsed/);
    await page.keyboard.press("Alt+Shift+KeyB");
    await expect(app).toHaveClass(/sidebar-collapsed/);

    await page.reload();
    await page.getByTitle("Keybindings").click();
    await expect(toggleBinding).toContainText("Alt+Shift+B");

    const nextBinding = popup.getByRole("button", { name: "Change shortcut for Next PTY" });
    await nextBinding.click();
    await page.keyboard.press("Alt+Shift+KeyB");
    await expect(popup.getByRole("status")).toContainText("already used by Toggle sidebar");
    await expect(nextBinding).toContainText("Press shortcut");
    await page.keyboard.press("Escape");
    await expect(popup).toBeVisible();

    await toggleBinding.click();
    await page.keyboard.press("Backspace");
    await expect(toggleBinding).toContainText("Ctrl+Shift+\\");
  } finally {
    await page.request.put(`/api/settings?token=${encodeURIComponent(token)}`, {
      data: { keybindings: {} },
    });
  }
});

test("configured shortcut cycles, cancels, and submits Claude model presets", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  test.skip(!hasTmux, "requires tmux");
  const logRoot = process.env.E2E_AGENT_LOG_ROOT;
  test.skip(!logRoot, "requires isolated agent log root");

  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
  const binDir = `/tmp/agmux-e2e-claude-presets-${suffix}`;
  const sessionId = `e2e-presets-${suffix}`;
  const logDir = path.join(logRoot!, "claude", "projects", "e2e-presets");
  const logFile = path.join(logDir, `${sessionId}.jsonl`);
  let ptyId: string | null = null;

  fs.mkdirSync(binDir, { recursive: true });
  await execFileAsync("ln", ["-sf", "/bin/sleep", `${binDir}/claude`]);

  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);
  await page.request.put(`/api/settings?token=${encodeURIComponent(token)}`, {
    data: {
      claudeModelPresets: [
        { id: "fast", name: "Fast", model: "sonnet", effort: "low" },
        { id: "deep", name: "Deep review", model: "claude-opus-4-7", effort: "xhigh" },
      ],
      keybindings: {
        claudeModelPreset: { code: "KeyM", ctrl: false, shift: true, alt: true, meta: false },
      },
    },
  });

  try {
    await page.reload();
    await newShellSession(page);
    ptyId = await page.locator(".pty-item.active").getAttribute("data-pty-id");
    expect(ptyId).toBeTruthy();

    const ptysResponse = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`);
    const ptysJson = (await ptysResponse.json()) as { ptys?: Array<{ id: string; cwd?: string | null }> };
    const cwd = ptysJson.ptys?.find((pty) => pty.id === ptyId)?.cwd;
    expect(cwd).toBeTruthy();

    await page.evaluate(
      () => (window as any).__agmux?.sendInput?.('echo "❯ Test Claude preset switching"\r'),
    );

    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      logFile,
      JSON.stringify({
        type: "user",
        sessionId,
        cwd,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Test Claude preset switching" },
      }) + "\n",
      "utf8",
    );

    await page.evaluate((command) => (window as any).__agmux?.sendInput?.(`${command}\r`), `${binDir}/claude 300`);
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`);
        const json = (await response.json()) as { ptys?: Array<{ id?: string; agentProvider?: string | null }> };
        return json.ptys?.find((pty) => pty.id === ptyId)?.agentProvider ?? null;
      }, { timeout: 20_000 })
      .toBe("claude");

    // Keep the attached provider metadata, but replace the fake Claude sleep
    // process with cat so submitted slash commands are visible in the terminal.
    await page.evaluate(() => (window as any).__agmux?.sendInput?.("\u0003"));
    await page.evaluate(() => (window as any).__agmux?.sendInput?.("cat\r"));

    const terminal = page.locator(".term-pane:not(.hidden) .xterm");
    await terminal.click();
    const chooser = page.getByRole("dialog", { name: "Switch Claude model" });
    await page.keyboard.press("Alt+KeyM");
    await expect(chooser).toHaveCount(0);
    await page.keyboard.press("Alt+Shift+KeyM");
    await expect(chooser).toBeVisible();
    await expect(chooser.getByRole("option", { name: /Fast/ })).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Alt+Shift+KeyM");
    await expect(chooser.getByRole("option", { name: /Deep review/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+Enter");
    await expect(chooser).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chooser).toHaveCount(0);

    const dumpActive = () => page.evaluate(() => String((window as any).__agmux?.dumpActive?.() ?? ""));
    expect(await dumpActive()).not.toContain("/model claude-opus-4-7");

    await page.keyboard.press("Alt+Shift+KeyM");
    await page.keyboard.press("Alt+Shift+KeyM");
    await page.keyboard.press("Enter");
    await expect(chooser).toHaveCount(0);
    await expect.poll(dumpActive, { timeout: 10_000 }).toContain("/model claude-opus-4-7");
    await expect.poll(dumpActive, { timeout: 10_000 }).toContain("/effort xhigh");
  } finally {
    if (ptyId) await killPty(page, token, ptyId).catch(() => {});
    await page.request.put(`/api/settings?token=${encodeURIComponent(token)}`, {
      data: { claudeModelPresets: [], keybindings: {} },
    }).catch(() => {});
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(logFile, { force: true });
  }
});

test("settings modal can follow the system theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?nosup=1");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".launch-modal h3")).toContainText("Settings");

  const themeSelect = page.locator(".launch-modal-select").first();
  await themeSelect.selectOption("dracula");
  await expect.poll(() => readRootCssVar(page, "--bg")).toBe("#0b0e14");

  const systemThemeCheckbox = page.getByRole("checkbox", { name: "Use system theme" });
  await systemThemeCheckbox.check();
  await expect(systemThemeCheckbox).toBeChecked();
  await expect(page.getByText("System theme is light, using Light.")).toBeVisible();
  await expect.poll(() => readRootCssVar(page, "--bg")).toBe("#ffffff");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByText("System theme is dark, using Dracula.")).toBeVisible();
  await expect.poll(() => readRootCssVar(page, "--bg")).toBe("#0b0e14");

  await page.reload();
  await expect.poll(() => readRootCssVar(page, "--bg")).toBe("#0b0e14");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(themeSelect).toHaveValue("dracula");
  await expect(systemThemeCheckbox).toBeChecked();

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.getByText("System theme is light, using Light.")).toBeVisible();
  await expect.poll(() => readRootCssVar(page, "--bg")).toBe("#ffffff");
});

test("GET /api/worktrees returns git worktree list entries", async ({ page }) => {
  const token = await readSessionToken(page);
  const res = await page.request.get(`/api/worktrees?token=${encodeURIComponent(token)}`);
  expect(res.ok()).toBe(true);
  const data = await res.json();
  expect(data.repoRoot).toBeTruthy();
  expect(Array.isArray(data.worktrees)).toBe(true);
  for (const wt of data.worktrees) {
    expect(wt.name).toBeTruthy();
    expect(wt.path).toBeTruthy();
  }
});

test("launching in new worktree creates sibling directory", async ({ page }) => {
  const token = await readSessionToken(page);
  const testBranch = `e2e-wt-${Date.now()}`;

  try {
    // Create worktree via API (same as launch modal does)
    const res = await page.request.post(`/api/ptys/launch?token=${encodeURIComponent(token)}`, {
      data: {
        agent: "shell",
        worktree: "__new__",
        branch: testBranch,
        baseBranch: "main",
      },
    });
    expect(res.ok()).toBe(true);
    const { id: ptyId } = await res.json();

    // Verify worktree appears in API listing
    const wtRes = await page.request.get(`/api/worktrees?token=${encodeURIComponent(token)}`);
    const wtData = await wtRes.json();
    const created = wtData.worktrees.find((wt: any) => wt.branch === testBranch);
    expect(created).toBeTruthy();

    // Verify it's a sibling (not under .worktrees/)
    expect(created.path).not.toContain("/.worktrees/");

    // Cleanup: kill pty
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  } finally {
    // Cleanup: find the worktree path from git and remove it
    try {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"]);
      const blocks = stdout.split(/\n\n+/);
      for (const block of blocks) {
        if (block.includes(`branch refs/heads/${testBranch}`)) {
          const pathMatch = block.match(/^worktree (.+)$/m);
          if (pathMatch) {
            await execFileAsync("git", ["worktree", "remove", "--force", pathMatch[1]]).catch(() => {});
          }
          break;
        }
      }
    } catch {
      // ignore
    }
    await execFileAsync("git", ["branch", "-D", testBranch]).catch(() => {});
  }
});

test("session preview modal opens on inactive session click and shows conversation", async ({ page }) => {
  const token = await readSessionToken(page);

  // Mock the agent-sessions API to return a fake inactive session,
  // and the conversation endpoint to return test messages.
  const fakeProvider = "claude";
  const fakeSessionId = "e2e-preview-test-session";
  // Use a unique projectRoot so the sidebar title ("e2e-preview-project") is distinct.
  const fakeProjectRoot = "/tmp/e2e-preview-project";
  const fakeAgentSession = {
    id: `agent:${fakeProvider}:${fakeSessionId}`,
    provider: fakeProvider,
    providerSessionId: fakeSessionId,
    name: "Preview test session",
    command: fakeProvider,
    args: ["--resume", fakeSessionId],
    cwd: fakeProjectRoot,
    cwdSource: "log",
    projectRoot: fakeProjectRoot,
    worktree: null,
    createdAt: Date.now() - 86400_000,
    lastSeenAt: Date.now() - 3600_000,
    lastRestoredAt: null,
  };

  const fakeMessages = [
    { role: "user", text: "Fix the authentication bug" },
    { role: "assistant", text: "I'll look at the auth module and fix the bug." },
    { role: "user", text: "Also add tests please" },
    { role: "assistant", text: "Adding unit tests for the auth module now." },
  ];

  // Intercept the conversation endpoint for our fake session
  await page.route(
    `**/api/agent-sessions/${fakeProvider}/${fakeSessionId}/conversation`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: fakeMessages }),
      });
    },
  );

  // Intercept the agent-sessions list — replace with ONLY our fake session to avoid
  // auto-collapse/archive behavior from real sessions on this machine.
  await page.route((url) => url.pathname === "/api/agent-sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [fakeAgentSession] }),
    });
  });

  // Make the fake session's cwd appear to exist so it lands in Inactive (not auto-archived).
  await page.route((url) => url.pathname === "/api/directory-exists", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ exists: true }),
    });
  });

  await page.goto("/?nosup=1");

  // The sidebar shows the project folder name ("e2e-preview-project"), not session.name.
  await ensureInactiveItemVisible(page, "e2e-preview-project");
  const inactiveItem = page.locator(`.pty-item.inactive`).filter({ hasText: "e2e-preview-project" });
  await expect(inactiveItem).toBeVisible({ timeout: 10_000 });

  // Click the inactive session to open preview modal (not the > arrow)
  await inactiveItem.click();

  // Preview modal should appear
  const previewModal = page.locator(".session-preview-modal");
  await expect(previewModal).toBeVisible({ timeout: 5_000 });

  // Modal title uses session.name (displayed via displaySessionIntent/displaySessionTitle).
  await expect(previewModal.locator("h3")).toContainText("Preview test session");

  // Should show conversation messages
  await expect(previewModal.locator(".session-preview-msg")).toHaveCount(4, { timeout: 5_000 });
  await expect(previewModal.locator(".session-preview-msg.user").first()).toContainText("Fix the authentication bug");
  await expect(previewModal.locator(".session-preview-msg.assistant").first()).toContainText("I'll look at the auth module");

  // Close with Escape
  await previewModal.press("Escape");
  await expect(previewModal).not.toBeVisible({ timeout: 3_000 });

  // Re-open and test Restore button
  await inactiveItem.click();
  await expect(previewModal).toBeVisible({ timeout: 5_000 });

  // Click Restore button — should close preview and open restore modal
  await previewModal.getByRole("button", { name: "Restore" }).click();
  await expect(previewModal).not.toBeVisible({ timeout: 3_000 });

  // Restore session modal should now be visible
  const restoreModal = page.locator(".restore-session-modal");
  await expect(restoreModal).toBeVisible({ timeout: 5_000 });

  // Close restore modal
  await restoreModal.press("Escape");
  await expect(restoreModal).not.toBeVisible({ timeout: 3_000 });
});

test("arrow button on inactive session opens restore modal directly (not preview)", async ({ page }) => {
  const token = await readSessionToken(page);

  const fakeProvider = "claude";
  const fakeSessionId = "e2e-arrow-test-session";
  const fakeAgentSession = {
    id: `agent:${fakeProvider}:${fakeSessionId}`,
    provider: fakeProvider,
    providerSessionId: fakeSessionId,
    name: "Arrow test session",
    command: fakeProvider,
    args: ["--resume", fakeSessionId],
    cwd: "/tmp/e2e-arrow-project",
    cwdSource: "log",
    projectRoot: "/tmp/e2e-arrow-project",
    worktree: null,
    createdAt: Date.now() - 86400_000,
    lastSeenAt: Date.now() - 3600_000,
    lastRestoredAt: null,
  };

  await page.route((url) => url.pathname === "/api/agent-sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [fakeAgentSession] }),
    });
  });

  // Make the fake session's cwd appear to exist so it lands in Inactive (not auto-archived).
  await page.route((url) => url.pathname === "/api/directory-exists", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ exists: true }),
    });
  });

  await page.goto("/?nosup=1");

  // The sidebar shows the project folder name ("e2e-arrow-project"), not session.name.
  await ensureInactiveItemVisible(page, "e2e-arrow-project");
  const inactiveItem = page.locator(`.pty-item.inactive`).filter({ hasText: "e2e-arrow-project" });
  await expect(inactiveItem).toBeVisible({ timeout: 10_000 });

  // Click the > arrow button specifically
  await inactiveItem.locator(".pty-actions-arrow").click();

  // Should open restore modal directly (not preview modal)
  const restoreModal = page.locator(".restore-session-modal");
  await expect(restoreModal).toBeVisible({ timeout: 5_000 });

  // Preview modal should NOT be visible
  const previewModal = page.locator(".session-preview-modal");
  await expect(previewModal).not.toBeVisible();

  // Close
  await restoreModal.press("Escape");
});

test("session preview modal shows loading state and handles empty conversation", async ({ page }) => {
  const token = await readSessionToken(page);

  const fakeProvider = "claude";
  const fakeSessionId = "e2e-empty-conv-session";
  const fakeAgentSession = {
    id: `agent:${fakeProvider}:${fakeSessionId}`,
    provider: fakeProvider,
    providerSessionId: fakeSessionId,
    name: "Empty conversation session",
    command: fakeProvider,
    args: ["--resume", fakeSessionId],
    cwd: "/tmp/e2e-empty-conv-project",
    cwdSource: "log",
    projectRoot: "/tmp/e2e-empty-conv-project",
    worktree: null,
    createdAt: Date.now() - 86400_000,
    lastSeenAt: Date.now() - 3600_000,
    lastRestoredAt: null,
  };

  await page.route((url) => url.pathname === "/api/agent-sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [fakeAgentSession] }),
    });
  });

  // Make the fake session's cwd appear to exist so it lands in Inactive (not auto-archived).
  await page.route((url) => url.pathname === "/api/directory-exists", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ exists: true }),
    });
  });

  // Return 404 for conversation (log file not found)
  await page.route(
    `**/api/agent-sessions/${fakeProvider}/${fakeSessionId}/conversation`,
    async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "log file not found for session" }),
      });
    },
  );

  await page.goto("/?nosup=1");

  // The sidebar shows the project folder name ("e2e-empty-conv-project"), not session.name.
  await ensureInactiveItemVisible(page, "e2e-empty-conv-project");
  const inactiveItem = page.locator(`.pty-item.inactive`).filter({ hasText: "e2e-empty-conv-project" });
  await expect(inactiveItem).toBeVisible({ timeout: 10_000 });

  await inactiveItem.click();

  const previewModal = page.locator(".session-preview-modal");
  await expect(previewModal).toBeVisible({ timeout: 5_000 });

  // Should show "No messages found" since the API returned 404
  await expect(previewModal.locator(".session-preview-loading")).toContainText("No messages found", { timeout: 5_000 });

  // Close with overlay click
  await page.locator(".launch-modal-overlay").click({ position: { x: 5, y: 5 } });
  await expect(previewModal).not.toBeVisible({ timeout: 3_000 });
});
