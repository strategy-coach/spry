# Repository Guidelines

## Project Structure & Module Organization
- `lib/universal/`: Reusable TypeScript utilities (filesystem walk, reflect, text, spawn) with `*_test.ts` alongside.
- `lib/std/`: SQLPage standard library: SQL modules (`index.sql`, `*.ddl.sql`) and TS helpers under `lib/std/lib/` and console pages under `lib/std/console/`.
- `support/assurance/e2e-prime/`: End‑to‑end harness (Deno + SQLPage) with `sqlpage.json`, `e2ectl.ts`, and example pages.
- `support/experiments/`: Prototypes and spikes (e.g., Drizzle, Zod). Not production code.

## Build, Test, and Development Commands
- Format: `deno fmt` and Lint: `deno lint` (run before committing).
- Unit tests: `deno test -A lib` (uses Deno’s built‑in test runner).
- E2E harness: `deno run -A support/assurance/e2e-prime/e2ectl.ts` (requires SQLPage installed; reads `sqlpage.json`).
- SQLPage preview (example): `sqlpage serve` from a directory with generated pages.

## Architecture Overview
- Runtime: SQLPage executes `.sql` pages under `lib/std/**` (and copies), backed by SQLite/Postgres.
- Tooling: Deno TypeScript utilities in `lib/universal/**` provide reflection, path trees, annotations, and spawning.
- Codegen/CLI: `lib/std/lib/cli.ts` builds a CLI used by `support/assurance/e2e-prime/e2ectl.ts` to inspect routes and emit SQLPage files.
- Console: `lib/std/console/**` contains navigable SQLPage UI (info schema, files, actions).

## Generating SQLPage Pages
- Preferred (packager script): `deno run -A support/assurance/e2e-prime/package.sql.ts` emits SQLPage files, printing head DDL, generated pages, then tail DDL.
- Direct CLI usage: `deno run -A support/assurance/e2e-prime/e2ectl.ts routes-tree` or `ls` to inspect; use `emitSqlPageFiles` from the CLI when embedding in scripts.
- Naming/layout: keep entrypoints as `index.sql`; place actions under `console/action/`; keep schema DDL in `lib/std/lib/*.ddl.sql`; replace `std/` prefix with `spry/` when publishing.

## Coding Style & Naming Conventions
- TypeScript: 2‑space indent, no default exports, prefer small modules; functions `camelCase`, types/classes `PascalCase`, constants `SCREAMING_SNAKE_CASE`, files `kebab-case.ts`.
- Tests: co‑locate as `*_test.ts` next to the code under test.
- SQL: prefer `snake_case` identifiers, keep module entrypoints as `index.sql`, schema DDL as `*.ddl.sql`.
- Run `deno fmt && deno lint` to enforce style.

## Testing Guidelines
- Write/extend unit tests for any new or changed behavior in `lib/**`.
- Use Deno’s assertions (`assertEquals`, etc.). Example: `deno test -A lib/universal/path-tree_test.ts`.
- E2E tests live under `support/assurance/e2e-prime/`; keep them hermetic and deterministic. Aim to maintain or improve coverage.

## Commit & Pull Request Guidelines
- Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:` (e.g., `feat: introduce routes utility`).
- PRs must include: clear description, linked issues, scope of changes, test plan (commands run and results), and screenshots for console/UI SQL pages when helpful.
- Keep diffs focused; update docs/tests with code.

## Security & Configuration Tips
- Do not commit secrets or ephemeral databases; `.gitignore` covers common cases. Prefer env vars and local config.
- Deno permissions: default to least privilege; use `-A` only for local dev/tests and document why when required.
