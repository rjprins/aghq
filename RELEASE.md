# Releasing agmux

agmux is published to npm as the scoped package **`@rjprins/agmux`** (the bare
name `agmux` is taken on npm by an unrelated package). The package installs two
binaries:

- `agmux` — starts the web UI (`dist/server.js`)
- `agmux-mcp` — the MCP stdio server (`dist/mcp/server.js`)

Because the package name is scoped, it is published with public access
(`publishConfig.access = "public"`).

## What ships in the package

The published tarball is controlled by the `files` allowlist in `package.json`:

- `dist/` — compiled server, MCP server, and shared code (`tsc` output)
- `public/index.html`, `public/styles.css`, `public/app.js`, `public/xterm.css`
  — the bundled UI (the `.map` is intentionally excluded)
- `scripts/agent-ready.mjs`, `scripts/install-mcp.mjs` — runtime/setup helpers
- `triggers/` — the example trigger module
- `docs/`, `README.md`, `LICENSE`

`prepublishOnly` runs `npm run build` (`tsc` + the esbuild UI bundle) so the
tarball always contains a fresh build. Asset paths resolve relative to the
package root (see `PACKAGE_ROOT` in `src/server/config.ts`), so a global install
serves its UI and exports its readiness helper correctly from any directory.

Verify the contents before releasing:

```sh
npm run build
npm pack --dry-run
```

## Supported Node versions

`engines.node` is `>=22`. CI builds and tests on Node 22 and 24. Native
dependencies (`better-sqlite3`, `node-pty`) ship prebuilt binaries for current
Node releases; a brand-new major may need to compile from source until those
prebuilds land.

## One-time setup

1. Be an owner/maintainer of `@rjprins/agmux` on npm (`npm owner ls @rjprins/agmux`).
2. Create an npm **automation** (or granular publish) token and add it to the
   GitHub repository as the secret **`NPM_TOKEN`**
   (`Settings → Secrets and variables → Actions`).

## Releasing (automated, recommended)

The `Release` workflow (`.github/workflows/release.yml`) publishes on a version
tag with npm provenance.

```sh
# 1. Make sure main is green and you are on it
git switch main && git pull

# 2. Bump the version (updates package.json and creates a vX.Y.Z commit + tag)
npm version patch   # or: minor | major

# 3. Push the commit and the tag
git push origin main --follow-tags
```

Pushing the `v*` tag triggers the workflow, which builds, tests, and runs
`npm publish --provenance --access public`.

## Releasing (manual fallback)

```sh
npm run build
npm pack --dry-run        # sanity-check contents
npm publish --access public
```

## Pre-release checklist

- [ ] `npm run build` succeeds
- [ ] `npm test` is green (CI covers Node 22 + 24)
- [ ] `npm pack --dry-run` includes `dist/`, the four `public/` assets, and
      `scripts/agent-ready.mjs`; excludes `node_modules`, `src`, `test`, `e2e`
- [ ] `README.md` install instructions and screenshot are current
- [ ] Version bumped per [semver](https://semver.org/)
- [ ] `NPM_TOKEN` secret is present (for the automated workflow)

## Product readiness

For the user-facing "minimum viable" feature checklist (sessions, launch UX,
projects, persistence), see [release-plan.md](release-plan.md).
