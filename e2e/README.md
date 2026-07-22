# End-to-end tests

The Playwright suite builds Quillra, launches `packages/api/dist/index.js`, and
points it at a brand-new SQLite database and workspace under the operating
system's temporary directory. The API serves the built SPA, matching the
single-origin production layout. The temporary installation is removed when
Playwright stops the server.

No real Anthropic, GitHub, or email service is used. The setup wizard receives
dummy GitHub App environment values and stores a placeholder Anthropic key. A
test-only server access token unlocks setup and no-email owner recovery. The
test then enables a local in-process SMTP server and verifies delivered codes
for collaborator and project-scoped client invitations. Browser requests to
non-local origins are blocked.

Run locally after installing Playwright and Chromium. The root script builds
the production bundles before Playwright launches the isolated API:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```
