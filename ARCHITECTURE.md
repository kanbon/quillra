# Architecture

This document is for people who want to read, modify, or extend Quillra.
It describes how the pieces fit together and why they're organised the way
they are. For how to run and contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## The mental model

Quillra is a chat-based editor that drives a real Git repository. The user
types what they want in plain language, an agent makes actual commits against
their project, and the existing hosting pipeline deploys them. There is no
headless CMS, no content database, and no separate "published" storage: the
repo is the source of truth.

Three pieces make that work:

1. **A React SPA** in the browser where the user chats, sees a live preview,
   and hits publish.
2. **A Hono backend** that owns the websocket chat loop, the workspace (one
   clone per project, one dev server per project), and a SQLite database for
   users, projects, memberships, conversations, and usage.
3. **The Claude Agent SDK** running in-process inside the backend. When a
   message arrives, the backend runs `query(...)` against the workspace clone
   with a scoped tool allow-list. Tool calls stream back over the websocket
   so the user sees file reads, edits, and command output in real time.

Everything else is supporting infrastructure: auth, email, billing limits,
the first-run setup wizard, and the GitHub App that lets us push without
personal access tokens.

## Repository layout

```
quillra/
  packages/
    api/                backend (Hono, Drizzle, Claude Agent SDK)
    web/                frontend (React, Vite, TailwindCSS)
  scripts/              one-shot maintenance scripts
  .github/workflows/    CI: typecheck, lint, em-dash check
  biome.json            formatter + linter config (shared by both packages)
  turbo.json            task runner config
  ARCHITECTURE.md       this file
  CONTRIBUTING.md       how to contribute
  README.md             product pitch and self-host guide
```

## Backend (`packages/api`)

### Entrypoint and composition

`packages/api/src/index.ts` is the Hono app. It wires up middleware (auth
context, CORS, cookies), mounts each route module, and starts the HTTP and
websocket servers. It does not contain business logic: every concrete
operation lives in `routes/` or `services/`.

### Routes (`src/routes/`)

Each file is a Hono sub-router. The chat-facing endpoints are split further
because `projects/` alone would be 1,200 lines otherwise.

```
routes/
  admin.ts              owner-only endpoints (usage reports, user list)
  clients.ts            public-ish endpoints for the branded client login
  github.ts             GitHub App webhook receivers
  instance.ts           public instance metadata (/impressum etc)
  setup.ts              first-run wizard API
  team-login.ts         passwordless 6-digit email code flow
  team.ts               team/member management
  projects/
    index.ts            composes the sub-routers into projectsRouter
    shared.ts           Variables type and auth helpers
    crud.ts             list, create, read, update, delete
    publish.ts          publish flow, changes diff, discard
    preview.ts          dev-server control and debug
    chat.ts             conversations and message history
    files.ts            file read, uploads, asset delete, logo
    presence.ts         collaborative-presence heartbeat
```

A route handler's job is to parse the request, check permissions, and call
into services. Database reads that are trivial (one row by id) stay in the
handler; anything non-trivial moves to a service.

### Services (`src/services/`)

Services are plain functions that own a single concern. They're the only
place that touches external systems (GitHub, filesystem, Anthropic API,
SMTP), and they're the only place that knows how to orchestrate a multi-step
operation.

```
services/
  agent.ts                      runs a chat turn against the Claude Agent SDK
  agent-prompts.ts              system prompts and per-framework hints
  agent-permissions.ts          tool allow-list by project role
  agent-stream-mapper.ts        translates SDK events into WS frames
  agent-diagnostics-tools.ts    dev-server diagnostics MCP server
  agent-humanizer.ts            friendly names for tool events in the UI
  astro-migration-skill.ts      the prompt for the Astro migration agent
  workspace.ts                  per-project clone, dev server, git ops
  framework.ts + registry       detect and describe the project framework
  github-app.ts + rest          GitHub App auth and REST calls
  crypto.ts                     secret storage with AES-GCM
  instance-settings.ts          key/value store for operator settings
  mailer.ts                     SMTP and Resend abstraction
  email-template.ts + -s.ts     branded email rendering
  usage-limits.ts               per-user and per-role spend caps
  usage-alert-emails.ts         threshold crossing notifications
  report-scheduler.ts           monthly usage report cron
  presence.ts                   in-memory who's-editing-what
  preview-status.ts             preview-server health polling
  image.ts                      sharp-based WebP pipeline
```

### Websocket layer (`src/ws/`)

`ws/chat-handler.ts` is the one file that ties the agent run, the project's
workspace, and the spend-limit checks together. Every chat message flows
through it:

1. Authenticate the connection (team, Better Auth, or client session).
2. Check the user is a member of this project.
3. Clone or update the project's repo.
4. Check if the user is already over their spend cap.
5. Run the agent with `runProjectAgent(...)`.
6. Stream events back to the browser.
7. Persist the assistant's final message, fire threshold alerts if any were
   crossed, clear the migration flag on a clean Astro migration exit, and
   emit a single `done` frame with total cost and duration.

It is the product's main runtime surface. It lives on its own so new chat
features don't become a diff on a 2,000-line entrypoint.

### Database (`src/db/`)

SQLite via Drizzle. Three files:

- `schema.ts` - re-exports the full schema (app + auth).
- `app-schema.ts` - projects, memberships, conversations, messages, usage,
  instance settings.
- `auth-schema.ts` - Better Auth tables (users, sessions, accounts).

Better Auth owns the user table; Quillra app tables reference `user.id` by
foreign key. There is no separate "owner" table: ownership is represented
by `user.instanceRole = "owner"`.

### Workspace model

Every project has exactly one clone on disk under `/opt/quillra/data/repos/<projectId>/`
and, while active, one preview dev server. The preview is a child process
the backend starts on demand; the user's browser talks to it through a
reverse proxy keyed by subdomain so every project has its own hot-reload
context.

Git operations are serialised per project with an in-process mutex because
concurrent chat turns used to race on `.git/index.lock`.

## Frontend (`packages/web`)

### Entrypoint and routing

`src/main.tsx` renders `<App />`. `src/App.tsx` is the router:

```
/                 -> Login (if no session) or Dashboard (if session)
/setup            -> first-run wizard, gated by /api/setup/status
/dashboard        -> project list
/projects/:id     -> Editor (chat + preview)
/projects/:id/settings  -> ProjectSettings
/settings         -> InstanceSettings (owner-only tabs)
/login, /login-client   -> passwordless login variants
/invite/:token    -> accept invite flow
/impressum        -> public legal page
```

Session state is checked centrally in `components/templates/SetupGate.tsx`
and `components/templates/RequireAuth.tsx`. Pages trust that if they render,
the user is authenticated.

### Atomic design

Components are grouped by complexity. The rule of thumb is how much state
and orchestration a component owns, not how big its JSX is:

```
components/
  atoms/        single-purpose UI primitives (Button, Input, Modal,
                Spinner, Heading, LogoMark, Textarea)
  molecules/    a handful of atoms with one clear job
                (ChatBubble, AskCard, CheckpointCard, SecretField, Tabs,
                 CopyMessageButton, PresenceAvatars, ToolEventRow)
  organisms/    feature-sized building blocks (ChatTranscript,
                ChatComposer, PreviewPane, ProjectCard, ProjectHeader,
                AppHeader, AvatarDropdown, MigrationBanner, etc.)
  templates/    auth and setup gates (RequireAuth, SetupGate)
```

When a page's JSX grows past ~200 lines, it's a sign to extract the major
sections into organisms. Examples already done:

```
organisms/setup/            the six first-run wizard steps
organisms/editor/           chat panel, preview panel, publish modal, hooks
organisms/project-settings/ stacked settings sections
organisms/instance-settings/ the owner-only settings tabs
```

### Pages (`src/pages/`)

Pages own routing and top-level state. They compose organisms and pass
callbacks down. The current set of page files averages around 150 lines
because the heavy lifting sits in organisms.

### Data layer (`src/lib/`, `src/hooks/`)

- `lib/api.ts` - `apiJson<T>(path, init?)` fetch wrapper with automatic
  session handling and typed JSON parsing.
- `lib/chat-store.ts` - Zustand store holding chat lines, per-project
  cost totals, and the per-turn tool event buffer. The websocket client
  writes to it; React reads via selectors.
- `lib/auth-client.ts` - Better Auth client wrapper.
- `lib/cn.ts` - `clsx` + `tailwind-merge`.
- `hooks/useProjectChat.ts` - opens the WS connection, pushes frames into
  the store, exposes `{lines, busy, error, send}`.
- `hooks/useProjectPresence.ts` - presence heartbeat.
- `hooks/useCurrentUser.ts` - session + user info via `/api/session`.

### i18n

`i18n/dictionaries.ts` holds English and German strings side by side.
`i18n/i18n.tsx` exports `useT()`. Every user-visible string in new code
goes through a dictionary key.

## Cross-cutting concerns

### Auth

Three session types flow through the same middleware:

- **Owner / team** sessions from Better Auth cookies (GitHub OAuth for the
  owner, passwordless email codes for everyone else).
- **Client** sessions from a custom cookie issued by `/api/clients/verify-code`.
  Scoped to one project; no GitHub account required.
- **Anonymous** for public endpoints like `/api/instance` and
  `/api/setup/status`.

The middleware populates `c.get("user")` and optionally
`c.get("clientSession")`. Handlers call `requireUser(c)` or check the
client session themselves.

### Permissions

Every project member has a role (`admin`, `editor`, `translator`, or `client`).
The agent's tool allow-list is derived from the role in
`services/agent-permissions.ts`, so clients can edit content files but can't
run arbitrary shell commands, and translators can only edit strings files.

### Usage and spend caps

`services/usage-limits.ts` reads from three scopes in order: per-user
override, per-role default, global default. The websocket handler consults
`shouldBlockRun(...)` before starting an agent turn. Crossing a warn or hard
threshold fires a dedupe-guarded email once per user per month.

### GitHub

Quillra uses a GitHub App, never a personal access token. The App is created
once at install time from the first-run wizard (a manifest flow). Installation
tokens are minted per operation, rotate every hour, and are scoped to the
repos the customer picked. `services/github-app.ts` handles app JWTs;
`services/github-rest.ts` is a thin REST client keyed off those tokens.

### Email

The mailer supports Resend and any SMTP provider. Setup is optional: with no
provider configured, invites become shareable URLs the operator copies and
sends themselves. All mail renders through a single branded template with
a text fallback so it survives Outlook and Gmail rendering.

## Tooling

- **Biome** is the only linter and formatter. `biome.json` sits at the repo
  root and applies to both packages.
- **TypeScript** strict mode is enforced everywhere. Errors are fixed, never
  silenced with `any`.
- **Turbo** runs `dev`, `build`, and `typecheck` across packages with
  caching.
- **`scripts/check-em-dashes.mjs`** fails the build if any source file
  contains a U+2014 character. The project style is ASCII punctuation only.
- **GitHub Actions** (`.github/workflows/ci.yml`) runs typecheck, lint, and
  the em-dash guard on every push and pull request.

## Where to add things

- **A new chat feature.** `packages/api/src/ws/chat-handler.ts` for the
  server side, `packages/web/src/lib/chat-store.ts` for the client event
  handling, and a new molecule or organism for the UI.
- **A new agent tool.** Add it to `services/agent-diagnostics-tools.ts` (or
  a new MCP server file) and allow-list it in `services/agent-permissions.ts`.
- **A new API endpoint on an existing resource.** Find the right sub-router
  under `routes/projects/` and add a handler. Keep it under 50 lines.
- **A new settings tab for the owner.** Add an organism under
  `components/organisms/instance-settings/` and a tab id to the page.
- **A new page.** Add a file under `src/pages/`, wire it into `App.tsx`,
  and follow the 200-line rule: anything bigger belongs in organisms.
- **A new email.** Add a function to `services/email-templates.ts` that
  calls `renderBrandedEmail` and a sender in the service that needs it.

## Things that are deliberately not here

- **A headless CMS layer.** The repo is the database.
- **A build step on publish.** Publish is `git push`, and the customer's
  existing CI handles the rest.
- **A multi-tenant cloud service from this codebase.** The managed SaaS at
  quillra.com runs this same code plus deployment glue we don't open-source.
  Single-tenant self-host is the primary shape.
- **Tests.** Not yet, but we're adding them. See Phase 5 in the recent
  commits and [CONTRIBUTING.md](CONTRIBUTING.md#tests) for the plan.
