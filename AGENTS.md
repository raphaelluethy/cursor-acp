# Repository Guidelines

## Project Structure & Module Organization
Source lives in `src/`. Key modules include the ACP agent (`src/cursor-acp-agent.ts`), Cursor CLI integration (`src/cursor-cli-runner.ts`), protocol mapping (`src/cursor-event-mapper.ts`), and prompt conversion (`src/prompt-conversion.ts`). Tests are in `src/tests/` and use the `.test.ts` naming pattern. Build output is emitted to `dist/` and should not be edited by hand. Documentation and notes live in `docs/`.

## Build, Test, and Development Commands
- `bun install`: install dependencies.
- `bun run build`: compile TypeScript to `dist/` via `tsc`.
- `bun run start`: run the built CLI from `dist/index.js`.
- `bun run dev`: build then start (handy for local iteration).
- `bun run lint` / `bun run lint:fix`: run Oxlint on `src/` (with or without auto-fix).
- `bun run format` / `bun run format:check`: format or verify formatting with `oxfmt`.
- `bun run check`: lint + format check (CI-friendly).
- `bun run test`: Vitest in watch mode.
- `bun run test:run`: one-shot test run.
- `bun run test:coverage`: one-shot run with coverage.

## Coding Style & Naming Conventions
This is an ESM TypeScript project. Follow existing patterns in `src/`: kebab-case filenames (for example `cursor-event-mapper.ts`), `camelCase` for variables/functions, `PascalCase` for classes/types, and `UPPER_SNAKE_CASE` for constants. Use `oxlint` and `oxfmt` as the primary style and formatting tools; ESLint/Prettier scripts exist for legacy checks.

## Testing Guidelines
Use Vitest and place new tests in `src/tests/` with a `.test.ts` suffix. Prefer focused unit tests for protocol mapping, CLI integration, and prompt conversion. Add or update tests alongside behavioral changes and run `bun run test:run` before opening a PR.

## Commit & Pull Request Guidelines
Commit messages generally follow Conventional Commits: `type: summary` (examples: `feat: ...`, `docs: ...`, `chore: ...`, `test: ...`). Keep the subject short and imperative. PRs should include a clear description, linked issues if applicable, and explicit test steps. Add screenshots or logs for user-facing or CLI output changes, and update `README.md` when the usage surface changes.

## Configuration & Requirements
Development expects Node.js 18+, Bun, and the Cursor CLI available on `PATH`. Ensure Cursor authentication is configured before running `bun run start` or `bun run dev`.
