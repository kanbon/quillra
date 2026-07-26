# Deploy and Host Quillra with Railway

Quillra is a self-hosted, AI-first CMS for teams and their clients. This
template deploys the Quillra control plane as one Railway service with durable
SQLite storage, while project dependencies, generated code, commands, and
preview servers run in isolated E2B sandboxes.

## About Hosting Quillra

The template creates one public Railway service and one persistent Volume.
Railway builds Quillra from the public
[`kanbon/quillra`](https://github.com/kanbon/quillra) repository and keeps the
control plane online. On first access, the protected browser wizard verifies
E2B, collects the Anthropic credential, creates and installs a dedicated GitHub
App, configures optional email, and creates the initial owner.

Provider credentials and customer data are never embedded in this public
template. Each deployment receives new internal signing, encryption, and setup
secrets.

## Common Use Cases

- Run an internal AI-assisted CMS without maintaining a VPS.
- Give clients access to only their assigned projects.
- Let team members connect and create projects from their own GitHub access.
- Publish through a repository-scoped Quillra GitHub App bot.
- Execute mutually untrusted project code outside the control-plane container.

## Dependencies for Quillra Hosting

- A Railway account for the control plane and persistent Volume.
- An [E2B](https://e2b.dev/) API key for isolated project execution.
- An [Anthropic](https://www.anthropic.com/) API key for AI editing.
- A GitHub account that can create and install the per-instance Quillra App.
- Optional Resend or SMTP credentials for production email delivery.

## First Access

1. Wait until the `quillra-cms` service reports a successful deployment.
2. Open its generated `*.up.railway.app` domain.
3. In Railway, open the service's **Variables** tab and copy the generated
   `QUILLRA_SETUP_TOKEN`.
4. Enter that token in Quillra and complete the browser wizard.

Do not manually set `E2B_ENABLED`. Quillra enables E2B only after a live,
private-sandbox verification succeeds.

## Preview Domains

The generated Railway domain works immediately using Quillra's compatibility
preview proxy. For router-transparent production previews, add a custom
control-plane domain and a wildcard domain such as
`*.preview.example.com`, then set `BETTER_AUTH_URL` and `PREVIEW_DOMAIN` as
described in the
[Railway deployment guide](https://github.com/kanbon/quillra/blob/main/docs/railway.md).
Wildcard DNS belongs to the operator and cannot be provisioned by a public
template.

## Security and Persistence

The Volume is mounted at `/app/packages/api/data` and stores SQLite, uploads,
encrypted instance settings, and credential-free project working copies. Keep
the generated `BETTER_AUTH_SECRET`, `QUILLRA_ENCRYPTION_KEY`, and
`QUILLRA_SETUP_TOKEN` stable across backups and redeployments.

Project code never executes in the Railway container. Quillra has no local
execution fallback when E2B is missing or unavailable.

## License

Quillra's source is publicly available under
[FSL-1.1-MIT](https://github.com/kanbon/quillra/blob/main/LICENSE). The current
version is Fair Source with a competing-use restriction and automatically
converts to MIT after two years. It is therefore not represented here as an
OSI-approved open-source license before that conversion date.
