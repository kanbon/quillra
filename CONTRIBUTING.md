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

No CLA signing required. We use the [Developer Certificate of Origin](https://developercertificate.org/), if that's unfamiliar, the short version is: only contribute code you actually wrote or have the right to contribute, and don't include anything you'd be embarrassed to have your name on.

## Reporting bugs

1. **Search [existing issues](https://github.com/kanbon/quillra/issues) first.** Someone may already be tracking it.
2. If it's new, open a **Bug report** using the issue template. Fill every field you can, the more we know up front, the faster it gets fixed.
3. For **security-sensitive** issues, please email the maintainers directly instead of filing a public issue. We'll acknowledge within a few working days.

Good bug reports include:

- A one-line summary of what went wrong
- Minimal reproduction steps
- What you expected vs what happened
- Your environment: OS, browser, Node version, which version of Quillra (commit SHA from `/api/setup/status` or the git log)
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
- `yarn` 1.22+ (`corepack prepare yarn@1.22.22 --activate`)
- `git` on your `PATH`
- A GitHub OAuth app (for sign-in) and an Anthropic API key (for the chat editor)

**Clone & install**

```bash
git clone https://github.com/kanbon/quillra.git
cd quillra
yarn install
cp packages/api/.env.example packages/api/.env
# Fill in ANTHROPIC_API_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_TOKEN,
# BETTER_AUTH_SECRET (openssl rand -base64 32), etc.
cd packages/api && DATABASE_URL=file:./data/cms.sqlite yarn db:push && cd ../..
yarn dev    # API :3000 + Vite :5173 via Turbo
```

First-run you'll also see the setup wizard at `http://localhost:5173/setup`, it's a nicer way to configure the secrets if you prefer a UI over editing `.env`.

**Project layout**

```
packages/api/       Hono + Better Auth + Drizzle (SQLite) + Claude Agent SDK
packages/web/       React 19 + Vite + Tailwind + React Query
```

**Before pushing**

Run the full check from the repo root:

```bash
yarn check
```

This runs typecheck, Biome (format + lint), and the em-dash guard in one
shot. All three must pass or CI will fail on your PR. Individual scripts
are also available: `yarn typecheck`, `yarn lint`, `yarn lint:fix`,
`yarn format`, `yarn check:em-dashes`.

<a id="tests"></a>
**Running tests**

```bash
yarn test           # run once
yarn workspace @quillra/api test:watch   # watch mode for the API package
```

Tests run with Vitest. The seed suites cover the secret-encryption wrapper
(`services/crypto.ts`), the framework detector (`services/framework-registry.ts`),
and the chat-transcript humanizer (`services/agent-humanizer.ts`). If you
touch anything with non-trivial logic, especially in `services/` or
`routes/`, please add tests alongside your change. Test files sit next to
the module they cover, as `*.test.ts`.

## Code style & conventions

- **TypeScript strict mode** is on everywhere. Don't widen types with `any` to silence errors, fix the root cause.
- **Biome** formats and lints everything. Run `yarn lint:fix` before you push. The config is at `biome.json` at the repo root and covers both packages.
- **No em-dashes.** The project style is ASCII punctuation only: `. , : ( )`. A pre-commit CI check rejects the U+2014 character in source files and prose. Long dashes belong in typography, not in source.
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
3. Run `yarn check` (typecheck + lint + em-dash guard). Everything must pass.
4. **If you touched anything that reads secrets or env files**, scan your diff:
   ```bash
   git diff --staged | grep -E 'sk-|ghp_|github_pat_|re_[a-z0-9]|API_KEY=[^$]|TOKEN=[^$]|PASSWORD=[^$]'
   ```
   Should be empty. Quillra is a public repo.
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
