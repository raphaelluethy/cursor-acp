# Repository Guidelines

## Project Structure & Module Organization
Source lives in `src/`. Key modules include the outer ACP agent (`src/cursor-acp-agent.ts`), the prompt-runner interface (`src/cursor-runner.ts`), the Cursor SDK backend (`src/cursor-sdk-runner.ts`), SDK event conversion (`src/cursor-sdk-event-adapter.ts`), model-id mapping (`src/model-id.ts`), and prompt conversion (`src/prompt-conversion.ts`). Production prompt execution uses `@cursor/sdk`; the adapter adds session persistence, history replay, model and mode controls, and ACP permission fallback behavior. The thinking selector maps SDK `thinking`, `reasoning`, or `effort` parameters while preserving the catalog id. The native ACP and legacy CLI runners remain compatibility surfaces, not the default prompt backend. Tests are in `src/tests/` and use the `.test.ts` naming pattern. Build output is emitted to `dist/` and should not be edited by hand. Documentation and notes live in `docs/`.

## Build, Test, and Development Commands
- `nub install`: install dependencies. A postinstall script patches the pinned `@cursor/sdk` so global CLI attribution settings are honored; install fails if that runtime code no longer matches.
- `nub run build`: compile TypeScript to `dist/` via `tsc`.
- `nub run start`: run the built CLI from `dist/index.js`.
- `nub run dev`: build then start (handy for local iteration).
- `nub run lint` / `nub run lint:fix`: run Oxlint on `src/` (with or without auto-fix).
- `nub run format` / `nub run format:check`: format or verify formatting with `oxfmt`.
- `nub run check`: lint + format check (CI-friendly).
- `nub run test`: Vitest in watch mode.
- `nub run test:run`: one-shot test run.
- `nub run test:coverage`: one-shot run with coverage.

## Coding Style & Naming Conventions
This is an ESM TypeScript project. Follow existing patterns in `src/`: kebab-case filenames (for example `cursor-event-mapper.ts`), `camelCase` for variables/functions, `PascalCase` for classes/types, and `UPPER_SNAKE_CASE` for constants. Use `oxlint` and `oxfmt` as the primary style and formatting tools; ESLint/Prettier scripts exist for legacy checks.

## Testing Guidelines
Use Vitest and place new tests in `src/tests/` with a `.test.ts` suffix. Prefer focused unit tests for protocol mapping, SDK runner behavior, event conversion, and prompt conversion. Add or update tests alongside behavioral changes and run `nub run test:run` before opening a PR.

## Commit & Pull Request Guidelines
Commit messages generally follow Conventional Commits: `type: summary` (examples: `feat: ...`, `docs: ...`, `chore: ...`, `test: ...`). Keep the subject short and imperative. PRs should include a clear description, linked issues if applicable, and explicit test steps. Add screenshots or logs for user-facing or CLI output changes, and update `README.md` when the usage surface changes.

## Configuration & Requirements
Development expects Node.js 22.13+ and Nub. Authenticate the Cursor SDK with `cursor-acp login` or `CURSOR_API_KEY` before starting an ACP session. The Cursor CLI is needed only when explicitly exercising the legacy CLI runner or native ACP bridge.
