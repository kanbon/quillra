<p align="center">
  <img src="assets/quillra-logo.webp" alt="Quillra" width="320" />
</p>

<h1 align="center">From vibe-coded to client-ready.</h1>

<p align="center">
  <strong>Quillra is the modern, GitHub-native CMS for sites you actually wanted to build.</strong>
  <br />
  Hand the keys to your clients without bolting WordPress, Typo3, or a headless CMS subscription onto a clean codebase.
  <br />
  <em>Self-host for free, or <a href="https://www.quillra.com">join the waitlist for the managed SaaS</a>.</em>
</p>

<p align="center">
  <img src="assets/quillra-editor.webp" alt="Quillra editor, chat on the left, live preview on the right" width="100%" />
</p>

<p align="center">
  <a href="#run-your-own-self-hosted"><strong>Self-host</strong></a> ·
  <a href="#how-it-works-in-practice"><strong>How it works</strong></a> ·
  <a href="#for-developers"><strong>For developers</strong></a> ·
  <a href="ARCHITECTURE.md"><strong>Architecture</strong></a> ·
  <a href="CONTRIBUTING.md"><strong>Contributing</strong></a>
</p>

---

## Why Quillra exists

You vibe-coded a beautiful site in Astro / Next / Vite / [whatever]. Now a real client needs to edit copy, swap photos, ship a new page, and you don't want to:

- 🚫 Rebuild the project on top of WordPress / Typo3 / Strapi / Sanity
- 🚫 Hand them a Git tutorial
- 🚫 Become their lifetime "please fix the headline" hotline
- 🚫 Pay per-seat for a multi-tenant CMS that owns your content

Quillra is the missing layer. Your repo stays the source of truth. Your client opens a chat, says *"change the homepage hero to 'Welcome to spring'"*, watches a live preview, hits **Publish**, and your existing CI deploys it. That's it.

> **Modern CMS for the post-WordPress generation.** Git is the database. Chat is the editor. Your hosting is unchanged.

## What it does

### Edit like a client, ship like a developer

The editing loop is chat on the left, live preview on the right. The client types what they want in plain language; the agent edits the real files in your repo; the preview reloads; they hit **Publish** and your existing CI deploys it.

- **Chat-first editing**: describe changes in plain language, no Markdown, no file paths
- **Live preview**: isolated per-project dev server that refreshes after edits. When it errors out, one click hands the error straight to the assistant
- **Real Git history**: every change is a real commit, attributed and reviewable
- **Your existing pipeline**: Pages, Vercel, Netlify, Cloudflare, your VPS; Quillra never touches hosting

### Run it for real customers

Project-scoped membership with a branded portal designed for non-technical website owners.

- **Branded client login**: per-project logo, email-code sign-in, no GitHub account required
- **Role-aware permissions**: admin / editor / client scopes baked into the agent's tool permissions, so clients can edit content files but never touch config
- **Email built in**: Resend or any SMTP provider. Invites, warnings, and reports all ride a shared HTML template that renders cleanly in Outlook and Gmail

### Know (and cap) what it costs

Designed for agencies passing Anthropic costs on to the customer.

- **Per-turn cost checkpoint** visible in chat the moment a task finishes
- **Organisation usage dashboard** with a per-user drill-down, 12-month chart + monthly / per-project / per-model tables
- **Warn + hard-cap thresholds** at global, per-role, or per-user scope. Owners bypass caps; everyone else sees a friendly "please contact the site owner" message when they hit one, and the warning email reaches you first
- **Monthly usage report** emailed to opted-in users, pass-through billing to clients, one click to enable per user

### One-click migrate to Astro

Built the site in **Lovable, Replit, Bolt, v0, or any other AI app builder**? You've got a React SPA that loads every page as a client bundle, fine to demo, rough to run for a real customer, and the builder's own UI is either too technical for them or exposes your credits and prompts.

Flip one toggle and Quillra rewrites the project as Astro in place: every page becomes static by default, images optimise on the build, interactivity survives as islands, and the React code still sitting around gets swept out. **Design parity is a hard requirement**: the migration agent walks every page and fixes any visual drift before reporting done, so the site the client signs off on looks pixel-identical to the one you handed over.

The end result: you hand the customer a clean, fast site and a chat-based editor they understand. The AI builder stays on your side of the fence.

<p align="center">
  <img src="assets/auto-migrate-astro.webp" alt="Convert to Astro toggle in the project settings" width="640" />
</p>

### Also

- **Smart file handling**: paste, drag, or click to upload. Images are routed to the framework's asset folder and optimised only when the framework doesn't already
- **Full i18n**: English and German UI today; the agent replies in the user's chosen language
- **Self-hosted**: one Docker container, your VPS, your data

## Frameworks we know

Auto-detected from `package.json`. The agent is told which framework it is editing so it follows that framework's conventions.

Astro · Next.js · Nuxt · Gatsby · SvelteKit · Remix · Eleventy · Vite · Create React App · Docusaurus · VitePress · Qwik · SolidStart

Your dev server command is auto-detected, or you can override it per project.

## How it works (in practice)

1. Connect a **GitHub repository** and branch, Quillra clones it on your server
2. Invite people by email; they use a **passwordless email code** and only see projects they belong to
3. They **chat** with the assistant, it reads and edits files in the workspace under role-aware rules
4. **Publish** runs `git push` so your existing pipeline deploys, exactly as if a developer pushed

Dev previews are detected from `package.json`, or you can set a custom command per project.

---

## Run your own (self-hosted)

You deploy **one Quillra instance** (VPS, internal server, Docker). There are no org tiers, only **projects** (one repo each) and **per-project** members.

| Variable | Purpose |
|----------|---------|
| `BETTER_AUTH_URL` | Public URL of the app (redirects and cookies) |
| `BETTER_AUTH_SECRET` | Session signing secret (`openssl rand -base64 32`) |
| `QUILLRA_ENCRYPTION_KEY` | Encrypts credentials stored in SQLite (`openssl rand -hex 32`) |
| `QUILLRA_SETUP_TOKEN` | Optional operator-chosen token that protects first-run setup and no-email recovery |
| `TRUSTED_ORIGINS` | Browser origins allowed to call the API with cookies |
| `PREVIEW_DOMAIN` | Dedicated wildcard parent domain for router-correct live previews |
| `ANTHROPIC_API_KEY` | Powers the Claude Agent SDK on the server |
| `EMAIL_PROVIDER` | `none` (default), `resend`, or `smtp`, powers invites, warnings, and monthly reports |

All other settings, GitHub App credentials (for cloning and pushing repos), Resend / SMTP keys, usage limits, alert email, `INSTANCE_*` Impressum fields, are configured at runtime from the Organization Settings page in the browser. The very first boot launches a setup wizard that walks the owner through them and creates the owner account with a passwordless email code.

Every team member connects their own GitHub identity before choosing a
repository. Quillra only shows the repositories where that person and the
installed GitHub App both have access, stores the immutable repository binding
on the project, and publishes with the Quillra App bot identity when GitHub
exposes it. Older GitHub Apps need the callback migration documented in
[SECURITY.md](./SECURITY.md#upgrading-an-existing-github-app).

Copy `packages/api/.env.example` to `packages/api/.env`, set the public URL,
origins, and production secrets, then start the container. Keep
`QUILLRA_ENCRYPTION_KEY` stable: it protects API keys and other credentials in
SQLite, so it belongs in the same backup plan as the data volume. The SQLite
schema bootstraps itself on first run; the browser wizard collects the remaining
values. Setup first asks for `QUILLRA_SETUP_TOKEN`. If you leave it empty,
Quillra derives an installation-specific token and prints it only to the server
logs (`docker compose logs cms`). With email delivery disabled, that same proof
is required before a one-time owner or recovery code can be shown in the browser.

Live previews use opaque, capability-authenticated child hosts of
`PREVIEW_DOMAIN`. Browser and dev server therefore see the same path, so SPA
routers, root-relative assets, fetch calls, and hot-reload WebSockets work
without repository-specific base-path changes. Wildcard DNS and TLS terminate
at Quillra's validating gateway; the workspace ports themselves remain bound to
loopback and must never be exposed publicly. A dedicated same-site subdomain
(for example, `cms.example.com` with `preview.example.com`) has the broadest
browser-cookie compatibility. A separate registrable domain adds isolation but
depends on browser support for partitioned third-party cookies. Local
development uses `*.localhost` automatically. Without `PREVIEW_DOMAIN`,
non-local installations fall back to the older path proxy, which cannot be
fully transparent to every client-side router.

Quillra installs dependencies and runs development commands from connected
repositories inside the application container. The browser preview is
sandboxed, but repository code is not a host-security boundary. Connect only
repositories and dependency trees you trust; use separate Quillra instances
when mutually untrusted teams need isolation.

**Server prerequisites:** Docker Engine with Compose, Git, OpenSSL, a text
editor, and curl for the health check. Caddy or another TLS reverse proxy is
optional but recommended for an internet-facing install. A source installation
additionally needs Node.js 22.13 or newer and Corepack on `PATH`. The image includes Node.js,
Corepack, npm, pnpm, Yarn Classic, and Git for the supported JavaScript
frameworks above. Non-Node generators such as Hugo and Jekyll are outside the
stock registry and image.

The Docker image builds Quillra with its pinned pnpm 10 release. For cloned
projects, Corepack honors an explicit `packageManager`; older pnpm projects
without that field use pnpm 9 so dependency lifecycle scripts keep working.

### Docker quickstart

```bash
git clone https://github.com/kanbon/quillra.git
cd quillra
cp packages/api/.env.example packages/api/.env
chmod 600 packages/api/.env

# Generate each value once, then paste it into packages/api/.env.
openssl rand -base64 32  # BETTER_AUTH_SECRET
openssl rand -hex 32     # QUILLRA_ENCRYPTION_KEY
openssl rand -base64 24  # QUILLRA_SETUP_TOKEN

# Also set BETTER_AUTH_URL, TRUSTED_ORIGINS, PREVIEW_DOMAIN, and ANTHROPIC_API_KEY.
${EDITOR:-vi} packages/api/.env
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 cms
curl -fsS http://127.0.0.1:3000/api/setup/status
```

Compose publishes Quillra only on host loopback. To terminate TLS with Caddy,
copy both site blocks and the `on_demand_tls` policy from
[`Caddyfile`](./Caddyfile), replace both example domains, create an `A`/`AAAA`
wildcard record for the preview domain, and set `PREVIEW_DOMAIN` to its parent.
Keep the upstream as `127.0.0.1:3000`. The ask endpoint permits on-demand leaf
certificates only for previews already reserved by an authorized user. Stable
project hosts avoid repeated issuance when access capabilities rotate. For many
projects, provision a real wildcard certificate through a DNS challenge instead
of issuing one leaf certificate per project. The validating `ask` URL is the
abuse boundary in the included example; add issuance limits only when sized for
your expected project count. The `on_demand_tls` policy is global in Caddy, so
merge it carefully on a shared server rather than replacing or silently
changing policy for unrelated sites.

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -fsS https://cms.yourdomain.com/api/setup/status
```

### Safe upgrades and rollback

Back up the entire named data volume while the app is stopped. This captures
SQLite's database, WAL files, and project workspaces together. The commands
below restart the old container before downloading and building the upgrade, so
a failed build does not extend the backup downtime.

```bash
set -euo pipefail
mkdir -p backups
chmod 700 backups
previous_commit="$(git rev-parse HEAD)"
container_id="$(docker compose ps -q cms)"
volume_name="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/app/packages/api/data"}}{{.Name}}{{end}}{{end}}')"
backup_name="quillra-data-$(date +%Y%m%d-%H%M%S).tgz"
test -n "$volume_name"
docker pull alpine:3.22

docker compose stop cms
docker run --rm \
  --mount "type=volume,src=$volume_name,dst=/data,readonly" \
  --mount "type=bind,src=$PWD/backups,dst=/backup" \
  alpine:3.22 tar -C /data -czf "/backup/$backup_name" .
docker compose start cms
printf '%s\n' "$previous_commit" > "backups/$backup_name.commit"
install -m 600 packages/api/.env "backups/$backup_name.env"
sha256sum "backups/$backup_name" "backups/$backup_name.env" > "backups/$backup_name.sha256"

git pull --ff-only
docker compose build cms
docker compose up -d cms
docker compose ps
docker compose logs --tail=100 cms
curl -fsS http://127.0.0.1:3000/api/setup/status
```

Keep the archive, checksum, environment backup, and commit marker until the
upgraded instance has been verified. To roll back, stop Quillra, restore the
complete archive and environment, and build the recorded source revision. The
restore command below intentionally replaces everything in the data volume.

```bash
set -euo pipefail
backup_name=quillra-data-YYYYMMDD-HHMMSS.tgz
previous_commit="$(cat "backups/$backup_name.commit")"
sha256sum -c "backups/$backup_name.sha256"
container_id="$(docker compose ps -q cms)"
volume_name="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/app/packages/api/data"}}{{.Name}}{{end}}{{end}}')"
test -n "$volume_name"

docker compose down
docker run --rm \
  -e BACKUP_NAME="$backup_name" \
  --mount "type=volume,src=$volume_name,dst=/data" \
  --mount "type=bind,src=$PWD/backups,dst=/backup,readonly" \
  alpine:3.22 sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /data -xzf "/backup/$BACKUP_NAME"'
install -m 600 "backups/$backup_name.env" packages/api/.env
git switch --detach "$previous_commit"
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/api/setup/status
```

The rollback intentionally leaves the checkout detached at the recorded
revision. Before attempting a later upgrade, return to the tracked branch:

```bash
git switch main
git pull --ff-only
```

The **Sites** dashboard lists every project you can access; from the editor, use the logo to return and connect more repositories. Organization Settings (owner only) covers email, API keys, team invites, usage, and spend controls.

### Don't want to self-host?

We're rolling out a managed SaaS, same product, we run the box. **Join the waitlist at [quillra.com](https://www.quillra.com).**

---

## For developers

```bash
corepack enable
pnpm install
cp packages/api/.env.example packages/api/.env   # fill secrets
pnpm dev    # API :3000 + Vite :5173 (Turbo)
```

Production build (SPA is copied into `packages/api/public`):

```bash
pnpm build
pnpm --filter @quillra/api start
```

Docker: see `Dockerfile` and `docker-compose.yml`; the Compose service publishes
port 3000 on host loopback for the included Caddy pattern and persists
`packages/api/data` for SQLite and workspaces.

Automated checks:

```bash
pnpm test       # Vitest unit and API integration tests
pnpm test:e2e   # production build + owner, collaborator, and client signup in Playwright
```

**Stack:** Hono, Better Auth, Drizzle + SQLite, Claude Agent SDK, sharp (API); React, Vite, React Router, TanStack Query, Tailwind (web). pnpm workspaces and Turborepo.

**UI:** Light, minimal chrome; accent `#C1121F` used sparingly.

**Components** follow atomic design under `packages/web/src/components/`: atoms, molecules, organisms, templates. Pages stay thin (routing and top-level state) and compose organisms.

**Architecture:** the full map of how the pieces fit together is in [ARCHITECTURE.md](./ARCHITECTURE.md). That's the document to read before your first non-trivial change.

**Code quality:** Biome formats and lints (`pnpm lint`, `pnpm format`). TypeScript is strict. A tiny guard script fails the build if any em-dash (U+2014) lands in source or prose: keep punctuation ASCII.

---

## Status

**Ready for use.** Used in production by agencies handing real CMSes to real clients. The surface is stable; ongoing work is polish, wider framework coverage, and the managed SaaS (waitlist open at [quillra.com](https://www.quillra.com)).

---

## Roadmap

What's next, grouped by theme. Order is rough priority, not commitment. PRs that move any of these forward are welcome (see [CONTRIBUTING.md](./CONTRIBUTING.md)).

&nbsp;

### Identity &amp; deploy

How commits land in the repo and how downstream pipelines react.

- **Optional commit-as-user.** Today, Quillra authenticates pushes through its GitHub App and uses the App bot's GitHub noreply identity for commits when available. These commits are not cryptographically signed. Vercel, Netlify, Cloudflare Pages, and GitHub Actions still build on those pushes the same way they would on a human push. The roadmap item is optional per-user attribution for repositories with stricter contributor or signed-commit rules.

- **Branch-based environments.** A "Publish to staging" toggle alongside the current Publish, so the agency's existing `staging` branch gets its own preview URL and the client signs off there before promoting.

- **Per-project deploy hooks.** Fire a Vercel / Netlify / custom deploy webhook after Publish, so non-Git deploys (CDN uploads, image-only changes) still rebuild.

&nbsp;

### Branding &amp; customization

Make every Quillra instance feel like the operator's product, not Quillra's.

- ✅ **Per-project white-label** *(shipped).* Each project carries its own display name, accent color, and logo, layered over an optional **project group** (one Quillra instance, many agencies, each with their own brand) and the instance defaults. Client login + editor chrome render the effective brand; nothing on those surfaces says "Quillra" to the client. Set up under Project Settings → Branding and Organization Settings → Groups.

- **Cross-project customer portal.** A `/portal/:groupSlug` landing page where a client logs in once and lands on a branded overview of every project they're a member of inside that group. Today they sign in per-project; this stitches them together.

- **Custom domain per group.** `edit.yourbrand.com` instead of `cms.example.com`. Adds the DNS + on-demand TLS plumbing for true white-label without the operator domain leaking into the URL bar.

- **Email template editor.** WYSIWYG for the invite, usage-warning, and monthly-report emails. Tag-style variables for fields like `{user_name}`, `{project_name}`, `{spend_month_to_date}`. Per-instance defaults, per-project overrides for agency-style "this is from Studio X" mailings.

- **Custom prompt addons per project.** The global Role Permissions tab (admin / editor / client) already exists. Extend it with a per-project block so an operator can pin "never change the brand voice" or "always confirm before pricing changes" for one specific site.

- **More UI languages.** English and German ship today; the dictionaries file is shaped for fr, es, it, nl, pt-BR. Translators welcome.

&nbsp;

### Editor &amp; content

The chat-and-preview surface itself.

- **Side-by-side diff viewer.** The hand-rolled unified-diff colorizer in the changes modal is fine for code, less great for prose. Word-level diffs help translators and clients spot subtle copy edits.

- **Content-collection awareness.** Surface Astro and Next.js content collections as structured cards in the chat ("Edit the *Spring 2026* blog post" rather than "Edit `src/content/blog/spring-2026.md`").

- **Image library per project.** Browseable view of every asset Quillra has uploaded to the repo, with rename, delete, and reuse-this-image-elsewhere.

&nbsp;

### Collaboration &amp; review

Multi-person editing of the same site.

- **Comments on commits.** A client can leave "I'm not sure about this headline" on a specific commit; the assistant sees it on the next turn and can ask, edit, or escalate.

- **Approval queue.** For agencies with strict workflows: every commit gets queued for an admin or editor to approve before Publish enables. Audit-friendly.

&nbsp;

### Operator polish

Owner-side controls and observability.

- **Audit log.** One timeline of who chatted, who published, who invited, who hit the cap. Export as CSV for billing and compliance.

- **Per-project usage limits.** Today's caps are global / per-role / per-user. Add a per-project axis so a flat-fee project can't quietly burn through the agency's monthly budget.

- **Bring-your-own model.** Plug a custom Anthropic gateway, Bedrock, or Vertex endpoint instead of the Anthropic public API. Useful for enterprise compliance and aggregated billing.

---

## Contributing

Contributions are welcome, bug reports, feature proposals, PRs, docs, framework support.

Start with the **[contributing guide](./CONTRIBUTING.md)**: it covers local setup, code style, commit conventions, how to file a good bug report, and what the license means for contributors.

We follow a [Code of Conduct](./CODE_OF_CONDUCT.md) (Contributor Covenant v2.1).

### Contributors

<a href="https://github.com/kanbon/quillra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=kanbon/quillra" alt="Contributors" />
</a>

<sub>Made with [contrib.rocks](https://contrib.rocks).</sub>

## License

Quillra is released under the **[Functional Source License v1.1, MIT Future License](./LICENSE)** (FSL-1.1-MIT).

In plain English:

- ✅ Free to **use commercially**: for your company, your clients, your agency, your side projects. Charge whatever you want for the work you do with it.
- ✅ Free to **fork, modify, and self-host** for your own use.
- ✅ After **two years**, every version automatically becomes full MIT, no restrictions at all.
- ❌ You may **not** use Quillra to build a **competing hosted/managed CMS service** (i.e. a "Quillra-as-a-service" competitor). That's the one thing we're protecting, because we run one ourselves.

If in doubt: self-hosting it for your own clients, your employer, or your own projects is always fine. Selling hosted Quillra to other people is not.
