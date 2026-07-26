# Deploy Quillra on Railway

Quillra runs as one long-lived Railway control-plane service. Railway builds the
root `Dockerfile`; `railway.json` configures its healthcheck, restart policy,
and deployment behavior. Repository-defined commands do not run in this
container. Dependency installation, lifecycle scripts, agent-approved shell
commands, and preview servers run in one isolated E2B sandbox per project.

Railway infrastructure still has to exist before that wizard can open. Quillra
checks it at boot and exits with an actionable error instead of writing durable
state to an ephemeral filesystem.

## One-time Railway checklist

1. Create a Railway service from this GitHub repository.
2. Enable HTTP Public Networking and generate a Railway domain. Quillra infers
   `BETTER_AUTH_URL=https://$RAILWAY_PUBLIC_DOMAIN` and adds it to
   `TRUSTED_ORIGINS`. If you use a custom control-plane domain, set
   `BETTER_AUTH_URL` explicitly to its HTTPS origin.
3. Attach exactly one Railway Volume to the service at:

   ```text
   /app/packages/api/data
   ```

   Do not mount it at `/data`. The image stores SQLite, its WAL, encrypted
   instance settings, uploaded assets, and credential-free project working
   copies below the application data directory.
4. Add stable secrets as Railway service variables:

   ```text
   BETTER_AUTH_SECRET=<at least 32 random bytes>
   QUILLRA_ENCRYPTION_KEY=<64 lowercase hexadecimal characters>
   QUILLRA_SETUP_TOKEN=<unguessable operator token>
   ```

   Keep all three stable across deploys and backups. Losing the encryption key
   makes stored E2B, GitHub, Anthropic, and email credentials unreadable.
5. Keep the service at **one replica** and leave Serverless/Sleep disabled.
   SQLite, project locks, WebSockets, agent runs, and sandbox lifecycle state
   belong to one control-plane process. Railway also does not support replicas
   for services with a Volume.
6. Deploy and open the generated domain. Enter `QUILLRA_SETUP_TOKEN`, then let
   the browser wizard configure:

   - the required E2B API key and optional custom template id;
   - the Anthropic API key;
   - creation and installation of the Quillra GitHub App;
   - optional email delivery;
   - the initial owner account.

   E2B setup creates a temporary network-closed sandbox, runs a fixed command,
   and probes a private HTTP endpoint. The probe requires E2B's traffic token
   at the edge and confirms the token is stripped before sandbox code receives
   the request. Quillra writes its internal `E2B_ENABLED` flag only after that
   live check succeeds and the sandbox is removed. Do not add or set
   `E2B_ENABLED` as a Railway variable.

`DATABASE_URL=file:./data/cms.sqlite` and
`WORKSPACE_DIR=./data/workspaces` are the correct image defaults. Railway
provides `PORT`; Quillra listens on `0.0.0.0:$PORT`. The configured healthcheck
is `/api/setup/status`, which returns successfully before setup is complete.

After those six steps, setup and normal operation happen in the browser. A root
server, Docker-in-Docker, host Docker socket, and per-project host folders are
not required. Railway runs the control plane and E2B supplies project execution.

## Live preview domains

The generated `*.up.railway.app` control-plane domain is enough to finish setup
and use Quillra's compatibility preview proxy. For router-transparent live
previews, add both of these custom domains to the same service:

- the control-plane domain, for example `cms.example.com`;
- a wildcard preview domain, for example `*.preview.example.com`.

Then set:

```text
BETTER_AUTH_URL=https://cms.example.com
PREVIEW_DOMAIN=preview.example.com
```

Railway terminates TLS and forwards both hostnames to the same `PORT`; no Caddy
sidecar is required. Configure the DNS records Railway displays for both
domains. Quillra's preview gateway proxies HTTP and WebSocket traffic to the
project's E2B preview host and injects the E2B traffic access token server-side.
Quillra does not intentionally expose the direct sandbox URL. Untrusted preview
code can still reflect its upstream hostname, but that hostname is not a
credential: the traffic token never reaches the browser or project code.

Host mode is also the recommended security configuration. Compatibility mode
keeps a longer-lived Quillra bearer in rewritten preview URLs so nested assets
and WebSockets can authenticate; treat those URLs as secrets. A wildcard
preview domain instead exchanges a 60-second, one-use handoff for an HttpOnly
session bound to the exact project host and port.

## Published Railway Template checklist

`railway.json` configures one service deployment, but it cannot publish a
Marketplace Template, claim Template ownership, or attach account-owned
infrastructure. In Railway's Template Composer, the publisher must configure:

- this repository and its root `Dockerfile`;
- HTTP Public Networking with a generated domain;
- one Volume mounted at `/app/packages/api/data`;
- exactly one replica and Serverless/Sleep disabled;
- generated `BETTER_AUTH_SECRET`, for example `${{ secret(48) }}`;
- generated `QUILLRA_ENCRYPTION_KEY`, for example
  `${{ secret(64, "0123456789abcdef") }}`;
- generated `QUILLRA_SETUP_TOKEN`, for example `${{ secret(32) }}`;
- optional user-facing variables for `PREVIEW_DOMAIN` and any environment
  override documented in `packages/api/.env.example`.

Do not put `E2B_API_KEY`, `ANTHROPIC_API_KEY`, GitHub App credentials, or mail
credentials into the published Template. The owner enters them through
Quillra's authenticated setup wizard on first access.

The publisher must create and publish the Template in Railway's dashboard.
Marketplace publication, Template ownership, billing, and the generated
Deploy-on-Railway URL are external Railway state. Repository configuration
alone cannot perform those account-level actions.

## Security and recovery

The Railway container is the control plane and persistent draft store, not a
repository execution host. E2B receives project files and the minimum
command-specific environment only. Quillra does not send Anthropic, GitHub,
auth, mail, encryption, or E2B secrets into project sandboxes, and it has no
local execution fallback.

Back up the whole Railway Volume with the service stopped and keep all three
generated control-plane secrets stable. The backup contains SQLite, uploaded
assets, and local Git/draft state. E2B sandboxes are execution state, not the
durable source of truth.
