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

Dependency installers, preview servers, and agent-approved shell commands run
code from connected repositories in the Quillra application container. Only
connect repositories and dependencies you trust. The preview iframe protects
the browser; it does not turn repository code into a host sandbox. Project
directories and application authorization checks do not stop same-UID processes
from inspecting sibling processes, the SQLite data volume, or process
environment on the same host. Isolate mutually untrusted projects in separate
instances until Quillra supports a microVM or equivalent per-project execution
backend. Keep the Docker socket and host filesystem out of the container.

## GitHub trust boundaries

Quillra does not accept personal access tokens. Every signed-in team member
connects their own GitHub identity to the instance GitHub App. That user
authorization is encrypted at rest and is used only for repository discovery
and access checks by Quillra. The authorization remains write-capable because
the App requests `contents:write`, so it must be treated as a control-plane
secret. A project can be created or rebound only from an
installation/repository pair where that user currently has write access.

After connection, project membership is the authorization boundary: members of
that project can use its workspace without inheriting visibility into the
connecting user's other repositories. Network Git operations mint separate
read or write installation tokens restricted to the project's immutable GitHub
repository id. Tokens are injected only into the individual clone, fetch, or
push process and are never persisted in the remote URL. This limits accidental
cross-project credential reuse, but it does not defend against malicious code
already running as the same operating-system user; use the deployment isolation
rule above for mutually untrusted projects.

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
