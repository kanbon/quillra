<p align="center">
  <img src="assets/quillra-logo.png" alt="Quillra" width="320" />
</p>

# Quillra

## What it is

Quillra is an open-source **editor for websites that already live in GitHub**. Your clients and partners describe what they want in plain language; an AI assistant updates the real files in the repository, and **Publish** sends those changes to GitHub so your normal hosting (Cloudflare Pages, Vercel, Netlify, or anything that deploys from Git) picks them up.

Nothing from Quillra ships in the public site. Visitors see the same static or SSR app you already built. Quillra is only the **control room** you host yourself.

## The problem it solves

Shipping a modern site with today’s tools—Astro, Next.js, Vite, vibe-coding in Cursor or Lovable—is straightforward. What stays hard is the **handoff**: giving **clients, marketing, or partners** a safe way to change copy, images, and structure **without** turning the project into WordPress, a headless CMS subscription maze, or a second codebase they cannot touch.

Legacy-style products solved “non-dev editing” by owning the stack or the database. Quillra takes a different path: **Git stays the source of truth**, and the **AI layer** turns natural language into real commits in that repo. Editors work in a **chat-first UI** with a **live dev preview**, so updating the site feels closer to “explain the change” than “learn the repo.”

## Who it’s for

- **Studios and freelancers** who ship Git-based sites and want collaborators to edit content without file trees and pull requests.
- **Teams** who outgrown “only engineers touch the site” but refuse to bolt a traditional CMS onto an otherwise clean codebase.
- **Anyone self-hosting** who wants one instance for their org, not a multi-tenant SaaS product.

## How it works (in practice)

1. Connect a **GitHub repository** and branch; Quillra clones it on your server.
2. Invite people by email; they sign in with **GitHub** and only see projects they belong to.
3. They **chat** with the assistant; it reads and edits files in the workspace under **role-aware** rules (admins, editors, translators).
4. **Publish** runs `git push` so your existing pipeline deploys—same as if a developer pushed.

Dev servers for preview are **detected from `package.json`** (Astro, Next.js, Vite, and common `dev` scripts) or you can set a **custom command** per project.

---

## Run your own (self-hosted)

You deploy **one Quillra instance** (VPS, internal server, Docker). There are no org tiers—only **projects** (one repo each) and **per-project** members.

| Variable | Purpose |
|----------|---------|
| `BETTER_AUTH_URL` | Public URL of the API (OAuth callbacks and cookies). |
| `TRUSTED_ORIGINS` | Browser origins allowed to call the API with cookies. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth for sign-in. |
| `GITHUB_TOKEN` | Server-side token to clone, fetch, push, and list repos/branches in the UI. |
| `ANTHROPIC_API_KEY` | Powers the Claude Agent SDK on the server. |

Copy `packages/api/.env.example` to `.env`, fill the values, and run `yarn db:push` in `packages/api` after schema changes. Set the GitHub OAuth callback to `{BETTER_AUTH_URL}/api/auth/callback/github`.

**Server prerequisites:** Node.js, `git`, and a package manager on `PATH` so installs and previews work inside cloned workspaces.

The **Sites** dashboard lists every project you can access; from the editor, use **All sites** (or the logo) to return and connect more repositories.

---

## For developers

```bash
yarn install
cp packages/api/.env.example packages/api/.env   # fill secrets
cd packages/api && DATABASE_URL=file:./data/cms.sqlite yarn db:push && cd ../..
yarn dev    # API :3000 + Vite :5173 (Turbo)
```

Production build (SPA is copied into `packages/api/public`):

```bash
yarn build
node packages/api/dist/index.js
```

Docker: see `Dockerfile` and `docker-compose.yml`; persist `packages/api/data` for SQLite and workspaces.

**Stack:** Hono, Better Auth, Drizzle + SQLite, Claude Agent SDK, sharp (API); React, Vite, React Router, TanStack Query, Tailwind (web). Yarn workspaces and Turborepo.

**UI:** Light, minimal chrome; accent `#C1121F` used sparingly.

**Status (MVP):** GitHub OAuth, projects, team invites, chat with the agent, framework-aware preview, publish via `GITHUB_TOKEN`, role-aware tooling, image upload (WebP). Version history in the UI and rollback are planned later.

Frontend layout: `packages/web/src/components/` — atoms, molecules, organisms, templates (`RequireAuth`).

---

## Contributing

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
