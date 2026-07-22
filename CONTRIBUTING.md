# Contributing to Quillra

Thanks for your interest in making Quillra better! Whether you're filing a bug, proposing a feature, or shipping a pull request, you're welcome here.

This document covers:

- [The license you agree to by contributing](#license--dco)
- [Reporting bugs](#reporting-bugs)
- [Proposing features](#proposing-features)
- [Local development setup](#local-development-setup)
- [Code style & conventions](#code-style--conventions)
- [Submitting a pull request](#submitting-a-pull-request)
- [Commit message style](#commit-message-style)

## License & DCO

Quillra is released under the **[Functional Source License (FSL-1.1-MIT)](./LICENSE)**.

In plain English:

- ✅ You can use Quillra **commercially**: run it for your own company, your clients, your agency, your side projects. Charge whatever you want for the work you do with it.
- ✅ You can **fork it, modify it, and self-host it** for your own use.
- ✅ After **two years**, every version automatically becomes MIT-licensed, no restrictions at all.
- ❌ You **cannot** use Quillra to build a **competing hosted/managed CMS service** (i.e. a "Quillra-as-a-service" competitor). That's the one thing we're protecting, because we run one ourselves.

By submitting a pull request you confirm that:

1. You have the right to license your contribution under the same FSL-1.1-MIT terms, and
2. You're submitting your work under those terms.

No separate CLA or sign-off trailer is required. Only contribute code you
actually wrote or have the right to contribute under the terms above.

## Reporting bugs

1. **Search [existing issues](https://github.com/kanbon/quillra/issues) first.** Someone may already be tracking it.
2. If it's new, open a **Bug report** using the issue template. Fill every field you can, the more we know up front, the faster it gets fixed.
3. For **security-sensitive** issues, follow the private reporting steps in
   [SECURITY.md](./SECURITY.md) and open a
   [GitHub security advisory](https://github.com/kanbon/quillra/security/advisories/new).
   Never include a vulnerability or secret in a public issue.

Good bug reports include:

- A one-line summary of what went wrong
- Minimal reproduction steps
- What you expected vs what happened
- Your environment: OS, browser, Node version, and the Quillra commit SHA from the deployment checkout or Git log
- Console / server logs if relevant
- Screenshots or screen recordings if it's a UI issue

## Proposing features

Before building something big, **open a feature request issue first** so we can discuss:

- the user problem it solves,
- how it fits the rest of the app, and
- whether anyone else is already working on it.

Large PRs that come out of nowhere often need major rework before they can land. A 10-minute conversation up front saves both sides a lot of time.

## Local development setup

**Prerequisites**

- Node.js 22+
- pnpm 10.34+ (`corepack enable` uses the version pinned by this repository)
- `git` on your `PATH`
- An Anthropic API key (for the chat editor); the setup wizard creates the GitHub App

**Clone & install**

```bash
git clone https://github.com/kanbon/quillra.git
cd quillra
pnpm install
pnpm dev         # API :3000 + Vite :5173 via Turbo
```

Both API commands load `packages/api/.env` when it exists. A production build
can be started from the repository root with `pnpm --filter @quillra/api start`.

That's it. Open `http://localhost:5173/setup` in your browser and the
first-run wizard walks you through the rest (Anthropic API key, GitHub
App, optional email, owner account). If `QUILLRA_SETUP_TOKEN` is unset,
copy the installation-specific setup token printed by the API process.

The session-signing secret is generated automatically on first boot
(written to `packages/api/data/.boot-secret`, gitignored, mode 0600) so
local dev needs no `.env` file. **For production**, copy
`packages/api/.env.example` to `packages/api/.env` and set
`BETTER_AUTH_SECRET` explicitly so the secret lives outside the data
volume:

```bash
cp packages/api/.env.example packages/api/.env
# generate once: openssl rand -base64 32
```

**Project layout**

```
packages/api/       Hono + Better Auth + Drizzle (SQLite) + Claude Agent SDK
packages/web/       React 19 + Vite + Tailwind + React Query
```

**Before pushing**

Run the full check from the repo root:

```bash
pnpm check
```

This runs typecheck, Biome (format + lint), the em-dash guard, and unit tests in
one shot. Every check must pass or CI will fail on your PR. Individual scripts
are also available: `pnpm typecheck`, `pnpm lint`, `pnpm lint:fix`,
`pnpm format`, `pnpm check:em-dashes`.

<a id="tests"></a>
**Running tests**

```bash
pnpm test                                  # run once
pnpm test:e2e                              # build and test owner, collaborator, and client signup in Chromium
pnpm --filter @quillra/api test:watch      # watch mode for the API package
```

Vitest covers isolated backend logic and API/database integration. Playwright
builds the production SPA, starts it against an empty temporary SQLite database
and local SMTP server, and walks through first-run setup, owner recovery,
collaborator signup, and project-scoped client signup. If you touch
anything with non-trivial logic, especially in `services/` or `routes/`, add a
focused test alongside the change. Test files sit next to the module they cover,
as `*.test.ts`.

## Code style & conventions

- **TypeScript strict mode** is on everywhere. Don't widen types with `any` to silence errors, fix the root cause.
- **Biome** formats and lints everything. Run `pnpm lint:fix` before you push. The config is at `biome.json` at the repo root and covers both packages.
- **No em-dashes in English code and docs.** The CI style check scans the
  project source and Markdown while excluding localized dictionaries and
  license text.
- **React components** follow atomic design: `atoms/`, `molecules/`, `organisms/`, `templates/`. Primitives go in `atoms/` or `molecules/`, feature-sized blocks go in `organisms/`. Pages stay thin.
- **Tailwind** for all styling. No CSS-in-JS. `cn()` from `@/lib/cn` for conditional classes.
- **Small files, small functions.** If you find yourself needing a comment block to explain what a function does, it probably wants to be split up. The 200-line heuristic in [ARCHITECTURE.md](./ARCHITECTURE.md) is a good pressure gauge.
- **Comments explain why, not what.** Well-named code tells you what. A comment should document a non-obvious invariant, a workaround for a specific bug, or a hidden constraint.
- **No premature abstractions.** Three similar lines of code is better than a speculative helper.
- **No emoji in code or comments** unless the user-facing feature literally shows them.
- **i18n everything.** New user-facing strings go into `packages/web/src/i18n/dictionaries.ts` under a sensible key, with both `en` and `de` entries.

## Submitting a pull request

1. Fork the repo, branch from `main`, name your branch something descriptive (`fix/preview-flicker`, `feat/smtp-backend`).
2. Make your change. Keep it focused, if you find unrelated cleanup that's tempting, do it in a separate PR.
3. Run `pnpm check` (typecheck + lint + em-dash guard + tests). Everything must pass.
4. **If you touched anything that reads secrets or env files**, scan your diff:
   ```bash
   secret_pattern='(sk''-[A-Za-z0-9_-]{20,}|ghp_''[A-Za-z0-9]{20,}|github_pat_''[A-Za-z0-9_]{20,}|re_''[A-Za-z0-9]{20,}|(API_''KEY|TOKEN|PASSWORD)=[^[:space:]$<])'
   git diff --staged --no-ext-diff -U0 | grep -E '^\+[^+]' | grep -E "$secret_pattern" | grep -Eiv '(example|placeholder|x{6,}|your[_-])'
   ```
   No output after placeholder filtering is expected. If anything remains,
   inspect it and rotate any exposed credential before pushing. This heuristic
   complements review; it does not replace a dedicated secret scanner.
5. Push and open a PR against `main` using the template. Fill it out, describe the user problem and how your change fixes it.
6. A maintainer will review. If changes are requested, push follow-up commits to the same branch (no force-push, we squash on merge).

## Commit message style

We don't enforce Conventional Commits but we do like short, useful subject lines:

- `fix: boot flicker when upstream returns 500`
- `feat: SMTP backend via nodemailer`
- `ui: centered Editor / Project tabs in header`
- `chore: bump framework registry with Qwik`
- `docs: contributing guide`

The body of the commit (when needed) should explain **why**, not just **what**: the diff shows what. One paragraph, plus a `Co-Authored-By:` trailer if AI helped.

---

Thanks again, and welcome! 🪶
