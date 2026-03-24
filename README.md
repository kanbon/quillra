<p align="center">
  <img src="assets/quillra-logo.png" alt="Quillra" width="320" />
</p>

# Quillra

**Quillra** is an open-source, AI-assisted CMS for sites whose **source of truth is a GitHub repository**. You work in a chat-first editor; the app clones the repo, runs a dev preview, and uses an AI agent to read and edit files—**without embedding CMS code in the public site**.

**First-class target:** [Astro](https://astro.build/) and other static/SSR stacks—dev preview is **auto-detected** from `package.json` (Next.js, Vite, etc.) or you can set a custom command per project.

This repository is the **CMS control plane** you run on **your** host (VPS, internal server, etc.). The public site stays a normal repo with **no Quillra runtime** for visitors; production traffic still goes to Pages, Vercel, Netlify, or your own server after **`git push`**.

## Self-hosted deployment

Quillra is **not** a multi-tenant SaaS product: you deploy **one instance** for yourself or your team. There are no organizations or billing tiers—only **projects** (each linked to a GitHub repo) and **per-project** members.

| Variable | Purpose |
|----------|---------|
| `BETTER_AUTH_URL` | Public URL of the API (used for OAuth callbacks and cookies). |
| `TRUSTED_ORIGINS` | Browser origins allowed to call the API with cookies (include your Vite dev URL and your real site URL if the SPA is on another host). |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth for **Sign in with GitHub** (minimal scopes). |
| `GITHUB_TOKEN` | Server-side token for **clone, fetch, and push** on repos you connect. One token for the whole instance is typical. |
| `ANTHROPIC_API_KEY` | Claude Agent SDK on the server. |

In your GitHub OAuth app, set the callback to `{BETTER_AUTH_URL}/api/auth/callback/github`.

An optional **GitHub App** (`GITHUB_APP_*` in `.env.example`) can be wired later for installation-scoped tokens; **`GITHUB_TOKEN`** is the supported path for self-hosted setups today.

## Projects, invites, and roles

- **Projects** — One GitHub repo + branch + workspace + dev preview + publish (`git push`).
- **Members** — Per project: `admin`, `editor`, or `translator` (agent tooling respects role).
- **Invites** — Admins invite by email; invitees sign in with GitHub. Users only see projects they belong to.

### Single-project UX (“client” mode)

If a user has **exactly one** project (typical agency client with one site), the app should **skip the multi-project shell**: land them straight in the **Replit-like** experience—**chat + preview** full focus, minimal chrome—same as their only homepage/workspace.

Users with **multiple** projects get the normal dashboard and picker.

## Typical flow

1. **Repo on GitHub** — Your site’s source lives in a repo the server can access with `GITHUB_TOKEN`.
2. **Connect in Quillra** — Create a project (repo + branch); the server clones it and can install dependencies.
3. **Edit in chat** — The agent commits in the workspace; **Publish** pushes to GitHub so your host deploys.
4. **Collaborators** — Optional per-project invites (still not “org SaaS”—just access control).

## What you get

- **GitHub OAuth** — Sign-in; configure in env.
- **`GITHUB_TOKEN`** — Clone / fetch / push for connected repos on this instance.
- **Framework-aware dev preview** — Auto `dev` command or custom command with `{port}`.
- **Roles + invites** — Per-project; single-project users skip the dashboard.
- **Role-aware agent** — Tooling rules in the agent layer.
- **Monorepo** — `packages/api` (Hono, REST, WebSocket, auth, static SPA) and `packages/web` (React + Vite).
- **SQLite + workspaces** — VPS-friendly; mount `data` in Docker.

## Stack (planned)

| Layer | Choice |
|--------|--------|
| API | Hono, Better Auth, Drizzle + SQLite, **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), sharp |
| Web | React, Vite, React Router, TanStack Query, Tailwind + shadcn/ui |
| Repo tooling | Turborepo, Yarn workspaces |

## Design direction (UI)

- **Mode:** Light UI, mostly white and black.
- **Accent:** `#C1121F` — use sparingly (links, focus, key actions).
- **Chrome:** Flat surfaces; avoid drop shadows and heavy elevation.

## AI runtime (MVP)

The editor chat uses the **official Claude Agent SDK** (`query()` from [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)), with tooling scoped to the project workspace and **role-aware** `canUseTool` / path rules.

Requires **`ANTHROPIC_API_KEY`** and a host that can run the SDK’s Claude Code subprocess (e.g. your VPS).

## Configuration

Copy `packages/api/.env.example` → `.env` and set at least **`BETTER_AUTH_*`**, **`GITHUB_CLIENT_*`**, **`GITHUB_TOKEN`**, and **`ANTHROPIC_API_KEY`**. Run **`yarn db:push`** in `packages/api` after schema changes.

**Server prerequisites:** Node.js, `git`, and a package manager (`yarn` / `npm` / `pnpm`) available on `PATH` so dependency installs and dev previews work inside workspaces.

## Development

```bash
yarn install
cp packages/api/.env.example packages/api/.env   # fill secrets
cd packages/api && DATABASE_URL=file:./data/cms.sqlite yarn db:push && cd ../..
yarn dev    # API :3000 + Vite :5173 (Turbo)
```

Production build (SPA → `packages/api/public`, API → `packages/api/dist`):

```bash
yarn build
node packages/api/dist/index.js
```

Docker: see `Dockerfile` and `docker-compose.yml`. Mount `packages/api/data` for SQLite and workspaces.

## Frontend structure

Atomic layout under `packages/web/src/components/`:

- `atoms/` — buttons, inputs, typography, spinner, logo mark  
- `molecules/` — chat bubble (markdown), tool row  
- `organisms/` — transcript, composer (react-hook-form), preview pane, project card, header, connect-repo form  
- `templates/` — `RequireAuth`

## Status

MVP: GitHub OAuth, projects, team invites, chat via **Claude Agent SDK**, framework-aware dev preview, **Publish** (`git push` with `GITHUB_TOKEN`), role-aware tooling, image upload (WebP). Version history UI / rollback is planned later.

## Contributing

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
