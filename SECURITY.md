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
the browser; it does not turn repository code into a host sandbox. Isolate
mutually untrusted teams in separate instances and keep the Docker socket and
host filesystem out of the container.
