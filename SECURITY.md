# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities through
[GitHub's private security advisory flow](https://github.com/kanbon/quillra/security/advisories/new).
Do not include vulnerability details, credentials, tokens, customer data, or
exploit code in a public issue or discussion.

Include the affected version or commit, impact, reproduction steps, and any
suggested mitigation you have. A maintainer will confirm receipt and coordinate
validation, remediation, and disclosure with you in the private advisory.

If a secret may have been exposed, revoke or rotate it immediately. Do not wait
for the software fix before protecting the affected system.

## Supported versions

Security fixes target the latest release and the current `main` branch.
Self-hosters should upgrade to a fixed release promptly and keep a stopped,
full-volume backup available for rollback.

## Deployment trust model

Quillra separates the control plane from repository code execution. The
control-plane container owns authentication, authorization, encrypted settings,
the SQLite database, credential-free Git working copies, agent orchestration,
and GitHub operations. It does not run repository-defined shell commands,
dependency installers, lifecycle scripts, or preview servers.

Each project gets its own E2B sandbox for those processes. Quillra synchronizes
only project files across that boundary and rejects symbolic links, special
filesystem entries, unsafe paths, and over-limit snapshots. There is no local
execution fallback. If the E2B key has not passed the browser setup live test,
or if the assigned sandbox cannot be reached, execution and preview operations
fail closed.

The E2B API key is a control-plane credential. Quillra stores it encrypted when
it is entered in the browser and sets the internal `E2B_ENABLED` state only
after creating a temporary sandbox, running a fixed probe, and removing it.
The same probe starts a fixed private HTTP endpoint, proves that requests
without E2B's traffic token are rejected, and fails setup if the token header
reaches sandbox application code.
`E2B_TEMPLATE_ID` is optional. Changing or resetting E2B configuration first
removes project sandboxes; a cleanup failure leaves the previous configuration
in place.

Anthropic, GitHub, authentication, mail, encryption, and E2B secrets are never
passed in sandbox environment variables. Preview traffic remains behind
Quillra's capability-authenticated gateway. Host preview URLs contain a
short-lived, single-use handoff. The gateway consumes it atomically and mints a
different HttpOnly session bound to the exact preview host, project, and port;
the handoff is never accepted as a cookie. The gateway adds E2B's traffic access
token to its server-side request. Quillra does not intentionally disclose the
direct sandbox URL, although untrusted preview code can reflect its upstream
hostname. The hostname alone is not a credential; the browser and project code
never receive the traffic token.

Without `PREVIEW_DOMAIN`, Quillra uses its compatibility path proxy. That mode
must keep a longer-lived bearer in rewritten preview URLs for nested assets and
WebSockets, and therefore provides weaker isolation than host mode. Treat those
URLs as secrets and configure a wildcard preview domain when untrusted users
can access previews.

E2B is an external security and availability boundary. Operators must protect
the E2B account and API key, review any custom template, keep Quillra's data
volume private, and keep the Docker socket and host filesystem out of the
control-plane container.

## GitHub trust boundaries

Quillra does not accept personal access tokens. A signed-in owner, admin, or
editor connects their own GitHub identity to the instance GitHub App when they
need to discover or bind a repository. That user authorization is encrypted at
rest and is used only for repository discovery and access checks by Quillra.
The authorization remains write-capable because the App requests
`contents:write`, so it must be treated as a control-plane secret. A project can
be created or rebound only from an installation/repository pair where that user
currently has write access.

After connection, project membership is the authorization boundary: members of
that project can use its workspace without inheriting visibility into the
connecting user's other repositories. Network Git operations mint separate
read or write installation tokens restricted to the project's immutable GitHub
repository id. Tokens are injected only into the individual clone, fetch, or
push process, are never persisted in the remote URL, and are never synchronized
to E2B. Repository commands in the sandbox therefore cannot read or reuse
GitHub credentials from the control plane.

Before and after each control-plane Git invocation, Quillra reconstructs the
repository-local Git config from a strict inert allowlist. This removes
executable fsmonitor, filter, diff, merge, include, alias, credential-helper,
proxy, and SSH settings that a workspace created by an older release may have
left behind. Commit identity is supplied only as per-process Git configuration.

Clients do not connect GitHub. A client only sees projects where they have
membership and can publish only when their project role permits it. Publishing
uses an exact-repository installation token and the Quillra App bot commit
identity when GitHub exposes one. It does not use the identity or credentials
of the client, and it does not reveal repositories outside that project. A
client cookie never inherits the underlying user row's instance role, including
when the same email also belongs to the owner: organization settings, setup,
GitHub connection, team management, and the owner's usage-cap exemption remain
unavailable.

### Upgrading an existing GitHub App

GitHub Apps created by older Quillra releases do not have the per-user OAuth
callback. Before users can connect GitHub or administrators can rebind a legacy
project:

1. Open the existing GitHub App settings.
2. Add `<BETTER_AUTH_URL>/api/github/connect/callback` under **Callback URLs**.
3. Set `GITHUB_APP_OAUTH_CALLBACK_URL` to that exact absolute URL and restart
   Quillra.

Quillra blocks the OAuth start when the configured value is absent or does not
match the current public URL. Recreating the App through the setup flow also
adds and records the callback automatically. Existing projects without an
immutable GitHub installation and repository id intentionally fail closed until
a project administrator reconnects them in project settings.
