import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Page, expect, test } from "@playwright/test";

const ownerEmail = "owner@quillra.test";
const setupToken = "quillra-e2e-setup-token";
const e2ePort = Number(process.env.QUILLRA_E2E_PORT ?? "3417");
const smtpPort = Number(process.env.QUILLRA_E2E_SMTP_PORT ?? String(e2ePort + 1));
const mailboxPath = path.join(tmpdir(), `quillra-e2e-mailbox-${e2ePort}.jsonl`);

type MailboxMessage = { receivedAt: number; raw: string };

function readMailbox(): MailboxMessage[] {
  try {
    return readFileSync(mailboxPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MailboxMessage);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function readDeliveredCode(email: string, requestedAt: number): Promise<string> {
  let deliveredCode = "";
  await expect
    .poll(
      () => {
        const message = readMailbox()
          .reverse()
          .find(
            ({ raw, receivedAt }) =>
              receivedAt >= requestedAt &&
              raw.toLowerCase().includes(email.toLowerCase()) &&
              raw.toLowerCase().includes("sign-in code"),
          );
        deliveredCode = message?.raw.match(/\b\d{6}\b/)?.[0] ?? "";
        return deliveredCode;
      },
      { message: `Expected a delivered sign-in code for ${email}`, timeout: 10_000 },
    )
    .toMatch(/^\d{6}$/);
  return deliveredCode;
}

async function readDeliveredMessage(
  email: string,
  requestedAt: number,
  content: RegExp,
): Promise<MailboxMessage> {
  let delivered: MailboxMessage | undefined;
  await expect
    .poll(
      () => {
        delivered = readMailbox()
          .reverse()
          .find(
            ({ raw, receivedAt }) =>
              receivedAt >= requestedAt &&
              raw.toLowerCase().includes(email.toLowerCase()) &&
              content.test(raw),
          );
        return Boolean(delivered);
      },
      { message: `Expected a delivered email for ${email}`, timeout: 10_000 },
    )
    .toBe(true);
  if (!delivered) throw new Error(`Email for ${email} was not delivered`);
  return delivered;
}

async function blockExternalRequests(page: Page) {
  const unexpectedHosts = new Set<string>();

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost") {
      await route.continue();
      return;
    }

    unexpectedHosts.add(url.hostname);
    await route.abort("blockedbyclient");
  });

  return unexpectedHosts;
}

async function readOneTimeCode(page: Page, prefix: RegExp): Promise<string> {
  const message = page.getByText(prefix);
  await expect(message).toBeVisible();
  const match = (await message.textContent())?.match(/\b\d{6}\b/);
  expect(
    match,
    "Server-authorized recovery should expose a six-digit one-time code",
  ).not.toBeNull();
  return match?.[0] ?? "";
}

test("a fresh production install supports owner, collaborator, and client signup", async ({
  browser,
  page,
}) => {
  const unexpectedExternalHosts = await blockExternalRequests(page);
  const browserErrors: string[] = [];
  let intentionallyFailingSession = false;
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    if (intentionallyFailingSession && location.includes("/api/session")) return;
    browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Confirm server access" })).toBeVisible();
  const setupTokenInput = page.getByLabel("Server access token");
  await expect(setupTokenInput).toBeFocused();
  await expect(page.getByRole("heading", { name: "Welcome to Quillra" })).toHaveCount(0);
  const welcomeHeading = page.getByRole("heading", { name: "Welcome to Quillra" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);

  const publicStatus = await page.request.get("/api/setup/status");
  expect(publicStatus.ok()).toBe(true);
  expect(await publicStatus.json()).toEqual({
    needsSetup: true,
    needsOwner: true,
    access: "token-required",
  });
  const anonymousCodeRequest = await page.request.post("/api/team-login/request-code", {
    data: { email: ownerEmail },
  });
  expect(anonymousCodeRequest.ok()).toBe(true);
  const anonymousCodeBody = await anonymousCodeRequest.json();
  expect(anonymousCodeBody).toEqual({ ok: true, recoveryRequired: true });
  expect(anonymousCodeBody).not.toHaveProperty("devCode");

  await setupTokenInput.fill(setupToken);
  await page.getByRole("button", { name: "Continue securely" }).click();
  await expect(welcomeHeading).toBeVisible();
  await expect(welcomeHeading).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole("button", { name: "Get started" }).click();
  const anthropicHeading = page.getByRole("heading", { name: "Anthropic API key" });
  await expect(anthropicHeading).toBeVisible();
  await expect(anthropicHeading).toBeFocused();
  await page.getByPlaceholder(/sk-ant-api03/).fill("sk-ant-e2e-placeholder-not-a-real-key");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "GitHub App" })).toBeVisible();
  const seededSmtp = await page.request.post("/api/setup/save", {
    data: {
      values: {
        EMAIL_PROVIDER: "smtp",
        EMAIL_FROM: "Quillra <hello@quillra.test>",
        SMTP_HOST: "smtp.quillra.test",
        SMTP_PORT: "587",
        SMTP_USER: "quillra-test",
        SMTP_PASSWORD: "smtp-resume-secret",
        SMTP_SECURE: "false",
      },
    },
  });
  expect(seededSmtp.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Welcome to Quillra" })).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(anthropicHeading).toBeVisible();
  await expect(page.getByText(/key is already configured/i)).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "GitHub App" })).toBeVisible();
  await expect(page.getByText("GitHub credentials found.")).toBeVisible();
  await expect(
    page.getByText(/verify repository access when you connect your first site/i),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Email delivery" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^SMTP/ })).toBeChecked();
  await expect(page.getByLabel("Host")).toHaveValue("smtp.quillra.test");
  await expect(page.getByLabel("User")).toHaveValue("quillra-test");
  await expect(page.getByLabel("Password")).toHaveValue("");
  await expect(page.getByText(/password is already configured/i)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Who's running this instance?" })).toBeVisible();
  const preservedSmtp = await page.request.get("/api/setup/status");
  expect(await preservedSmtp.json()).toMatchObject({
    values: { SMTP_PASSWORD: { set: true, source: "db" } },
  });

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("radio", { name: /Disabled/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  const disabledEmail = await page.request.get("/api/setup/status");
  expect(await disabledEmail.json()).toMatchObject({
    values: {
      EMAIL_PROVIDER: { value: "none" },
      EMAIL_FROM: { set: false },
      RESEND_API_KEY: { set: false },
      SMTP_HOST: { set: false },
      SMTP_PORT: { set: false },
      SMTP_USER: { set: false },
      SMTP_PASSWORD: { set: false },
      SMTP_SECURE: { set: false },
    },
  });

  await page.getByPlaceholder("Jane Doe").fill("Quillra Test Owner");
  await page.getByPlaceholder("hello@yourdomain.com").fill(ownerEmail);
  await page.getByRole("button", { name: "Continue" }).click();

  const ownerEmailInput = page.getByLabel("Owner email");
  await expect(ownerEmailInput).toHaveValue(ownerEmail);
  await page.getByRole("button", { name: "Send code" }).click();
  const signupCode = await readOneTimeCode(page, /One-time code:/);
  await page.getByLabel("6-digit code").fill(signupCode);
  await page.getByLabel("6-digit code").press("Enter");

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Sites" })).toBeVisible();

  // A transient session outage must fail closed in place, not turn a valid
  // install into a redirect loop. The explicit retry should recover without
  // losing the signed-in cookie.
  let interceptedSessionRequests = 0;
  intentionallyFailingSession = true;
  await page.route("**/api/session", async (route) => {
    interceptedSessionRequests += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary test outage" }),
    });
  });
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "We couldn't verify your session" })).toBeVisible({
    timeout: 20_000,
  });
  expect(interceptedSessionRequests).toBeGreaterThan(0);
  await page.unroute("**/api/session");
  intentionallyFailingSession = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Sites" })).toBeVisible();

  const firstSession = await page.request.get("/api/session");
  expect(firstSession.ok()).toBe(true);
  expect(await firstSession.json()).toMatchObject({
    kind: "team",
    projectId: null,
    user: { name: "Quillra Test Owner", email: ownerEmail, instanceRole: "owner" },
  });

  const completedSetup = await page.request.get("/api/setup/status");
  expect(completedSetup.ok()).toBe(true);
  expect(await completedSetup.json()).toMatchObject({
    needsSetup: false,
    needsOwner: false,
    missing: [],
    values: {
      ANTHROPIC_API_KEY: { set: true, source: "db" },
      GITHUB_APP_ID: { set: true, source: "env" },
      GITHUB_APP_PRIVATE_KEY: { set: true, source: "env" },
    },
  });

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByPlaceholder("you@example.com").fill(ownerEmail);
  await page.getByRole("button", { name: /Send.*sign-in code/i }).click();
  const recoveryTokenInput = page.getByLabel("Server access token");
  await expect(recoveryTokenInput).toBeVisible();
  await expect(recoveryTokenInput).toBeFocused();
  await expect(page.getByText(/one-time code is:\s*\d{6}/i)).toHaveCount(0);
  await recoveryTokenInput.fill(setupToken);
  await page.getByRole("button", { name: "Show one-time code" }).click();
  const loginCode = await readOneTimeCode(page, /Server access confirmed.*one-time code is:/i);
  await page.getByLabel("Sign-in code").fill(loginCode);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Sites" })).toBeVisible();
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/dashboard$/);

  const smtpSettings = await page.request.post("/api/setup/save", {
    data: {
      values: {
        EMAIL_PROVIDER: "smtp",
        EMAIL_FROM: "Quillra <hello@quillra.test>",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtpPort),
        SMTP_USER: null,
        SMTP_PASSWORD: null,
        SMTP_SECURE: "false",
      },
    },
  });
  expect(smtpSettings.ok()).toBe(true);

  const disconnectedGithub = await page.request.get("/api/github/connection");
  expect(disconnectedGithub.ok()).toBe(true);
  expect(await disconnectedGithub.json()).toMatchObject({
    connected: false,
    oauthCallbackConfigured: true,
    oauthCallbackUrl: `${new URL(page.url()).origin}/api/github/connect/callback`,
  });

  // Exercise Quillra's real OAuth state, PKCE, callback, encrypted connection,
  // and per-user repository discovery. The production process replaces only
  // GitHub's external HTTP responses with a strict deterministic fixture.
  const githubConnectStart = await page.request.get(
    "/api/github/connect/start?returnTo=/dashboard",
    { maxRedirects: 0 },
  );
  expect(githubConnectStart.status()).toBe(302);
  const githubAuthorizeUrl = new URL(githubConnectStart.headers().location);
  expect(`${githubAuthorizeUrl.origin}${githubAuthorizeUrl.pathname}`).toBe(
    "https://github.com/login/oauth/authorize",
  );
  expect(githubAuthorizeUrl.searchParams.get("client_id")).toBe("Iv1.quillra-e2e");
  expect(githubAuthorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(githubAuthorizeUrl.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  const githubOauthState = githubAuthorizeUrl.searchParams.get("state");
  expect(githubOauthState).toMatch(/^[\w-]{43}$/);

  const githubCallback = await page.request.get(
    `/api/github/connect/callback?code=quillra-e2e-oauth-code&state=${encodeURIComponent(
      githubOauthState ?? "",
    )}`,
    { maxRedirects: 0 },
  );
  expect(githubCallback.status()).toBe(302);
  expect(new URL(githubCallback.headers().location).pathname).toBe("/dashboard");

  const connectedGithub = await page.request.get("/api/github/connection");
  expect(connectedGithub.ok()).toBe(true);
  expect(await connectedGithub.json()).toMatchObject({
    connected: true,
    githubLogin: "quillra-e2e-owner",
  });
  const githubRepositoriesResponse = await page.request.get("/api/github/repos");
  expect(githubRepositoriesResponse.ok()).toBe(true);
  const githubRepositories = (
    (await githubRepositoriesResponse.json()) as {
      repos: Array<{
        repositoryId: string;
        installationId: string;
        fullName: string;
        defaultBranch: string;
      }>;
    }
  ).repos;
  expect(githubRepositories).toEqual([
    {
      repositoryId: "101",
      installationId: "11",
      fullName: "example/site-one",
      defaultBranch: "main",
    },
    {
      repositoryId: "102",
      installationId: "11",
      fullName: "example/site-two",
      defaultBranch: "main",
    },
  ]);

  const firstGithubRepository = githubRepositories[0];
  const firstProjectResponse = await page.request.post("/api/projects", {
    data: {
      name: "Quillra Site One",
      githubRepoFullName: firstGithubRepository.fullName,
      githubInstallationId: firstGithubRepository.installationId,
      githubRepositoryId: firstGithubRepository.repositoryId,
      defaultBranch: firstGithubRepository.defaultBranch,
    },
  });
  expect(firstProjectResponse.status()).toBe(201);
  const firstProjectId = ((await firstProjectResponse.json()) as { id: string }).id;

  const secondGithubRepository = githubRepositories[1];
  const secondProjectResponse = await page.request.post("/api/projects", {
    data: {
      name: "Quillra Site Two",
      githubRepoFullName: secondGithubRepository.fullName,
      githubInstallationId: secondGithubRepository.installationId,
      githubRepositoryId: secondGithubRepository.repositoryId,
      defaultBranch: secondGithubRepository.defaultBranch,
    },
  });
  expect(secondProjectResponse.status()).toBe(201);
  const secondProjectId = ((await secondProjectResponse.json()) as { id: string }).id;

  await page.goto(`/p/${firstProjectId}/settings`);
  await expect(page.getByRole("heading", { name: "One identity, everywhere." })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^(Brand|Branding)$/ })).toHaveCount(0);
  await page.getByLabel("Client-facing name").fill("Northstar Studio");
  await page.getByLabel("Accent color", { exact: true }).fill("#F4D35E");
  await page.locator('input[type="file"]').setInputFiles({
    name: "northstar.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHklEQVR4nGP4cjnuPyWYYdSA/6NhEDcaBpeHRRgAAK2/JC6kUrydAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  const unsavedPreviewCommand = "pnpm dev --draft";
  await page.getByLabel("Dev preview command").fill(unsavedPreviewCommand);
  await expect(page.getByText("Northstar Studio", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Save brand" }).click();
  await expect(page.getByText("Brand saved across client pages and emails.")).toBeVisible();
  await expect(page.getByLabel("Dev preview command")).toHaveValue(unsavedPreviewCommand);

  await page.reload();
  await expect(page.getByLabel("Client-facing name")).toHaveValue("Northstar Studio");
  await expect(page.getByLabel("Accent color", { exact: true })).toHaveValue("#F4D35E");
  await expect(page.getByAltText("Northstar Studio logo preview")).toBeVisible();
  await page.screenshot({
    path: path.join(tmpdir(), "quillra-brand-studio-desktop.png"),
    fullPage: true,
  });

  const anonymousLogoContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const publicLogo = await anonymousLogoContext.request.get(
    `/api/clients/branding/${firstProjectId}/logo`,
  );
  expect(publicLogo.status()).toBe(200);
  expect(publicLogo.headers()["content-type"]).toContain("image/png");
  expect((await publicLogo.body()).byteLength).toBeGreaterThan(0);
  await anonymousLogoContext.close();

  await page.getByRole("button", { name: "Sign-in" }).click();
  await expect(page.getByText("Welcome back")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);
  await expect(page.getByRole("button", { name: "Save brand" })).toBeVisible();
  await page.screenshot({
    path: path.join(tmpdir(), "quillra-brand-studio-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });

  const collaboratorEmail = "collaborator@quillra.test";
  const collaboratorInviteRequestedAt = Date.now();
  const collaboratorInviteResponse = await page.request.post(
    `/api/team/projects/${firstProjectId}/invites`,
    {
      data: { email: collaboratorEmail, name: "Quillra Collaborator", role: "editor" },
    },
  );
  expect(collaboratorInviteResponse.ok()).toBe(true);
  const collaboratorInvite = (await collaboratorInviteResponse.json()) as {
    emailConfigured: boolean;
    emailSent: boolean;
    inviteLink: string;
  };
  expect(collaboratorInvite.emailConfigured).toBe(true);
  expect(collaboratorInvite.emailSent).toBe(true);
  const deliveredCollaboratorInvite = await readDeliveredMessage(
    collaboratorEmail,
    collaboratorInviteRequestedAt,
    /invited you to/i,
  );
  const collaboratorInviteRaw = deliveredCollaboratorInvite.raw.replace(/=\r?\n/g, "");
  expect(collaboratorInviteRaw).toContain("Northstar Studio");
  expect(collaboratorInviteRaw).toContain("#F4D35E");
  expect(collaboratorInviteRaw).toContain(`/api/clients/branding/${firstProjectId}/logo`);
  expect(collaboratorInviteRaw).not.toContain("Quillra Site One");

  const collaboratorContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const collaboratorPage = await collaboratorContext.newPage();
  const collaboratorExternalHosts = await blockExternalRequests(collaboratorPage);
  const collaboratorErrors: string[] = [];
  collaboratorPage.on("console", (message) => {
    if (message.type() === "error") collaboratorErrors.push(message.text());
  });
  collaboratorPage.on("pageerror", (error) => collaboratorErrors.push(error.message));

  await collaboratorPage.goto(collaboratorInvite.inviteLink);
  await expect(collaboratorPage.getByLabel("Email")).toHaveValue(collaboratorEmail);
  const collaboratorCodeRequestedAt = Date.now();
  await collaboratorPage.getByRole("button", { name: /Send.*sign-in code/i }).click();
  const collaboratorCode = await readDeliveredCode(collaboratorEmail, collaboratorCodeRequestedAt);
  await collaboratorPage.getByLabel("Sign-in code").fill(collaboratorCode);
  await collaboratorPage.getByRole("button", { name: "Sign in" }).click();
  await expect(collaboratorPage).toHaveURL(/\/dashboard$/);
  await expect(collaboratorPage.getByRole("heading", { name: "Sites" })).toBeVisible();

  const collaboratorSession = await collaboratorPage.request.get("/api/session");
  expect(collaboratorSession.ok()).toBe(true);
  expect(await collaboratorSession.json()).toMatchObject({
    kind: "team",
    projectId: null,
    user: { email: collaboratorEmail, instanceRole: "member" },
  });
  const collaboratorProjects = await collaboratorPage.request.get("/api/projects");
  expect(collaboratorProjects.ok()).toBe(true);
  expect(await collaboratorProjects.json()).toMatchObject({
    projects: [{ id: firstProjectId, role: "editor" }],
  });

  const clientEmail = "client@quillra.test";
  const clientInviteRequestedAt = Date.now();
  const clientInviteResponse = await page.request.post(
    `/api/team/projects/${firstProjectId}/invites`,
    { data: { email: clientEmail, name: "Quillra Client", role: "client" } },
  );
  expect(clientInviteResponse.ok()).toBe(true);
  const clientInvite = (await clientInviteResponse.json()) as {
    emailConfigured: boolean;
    emailSent: boolean;
    inviteLink: string;
  };
  expect(clientInvite.emailConfigured).toBe(true);
  expect(clientInvite.emailSent).toBe(true);
  const deliveredClientInvite = await readDeliveredMessage(
    clientEmail,
    clientInviteRequestedAt,
    /invited you to/i,
  );
  const clientInviteRaw = deliveredClientInvite.raw.replace(/=\r?\n/g, "");
  expect(clientInviteRaw).toContain("Northstar Studio");
  expect(clientInviteRaw).toContain("#F4D35E");

  const clientContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const clientPage = await clientContext.newPage();
  const clientExternalHosts = await blockExternalRequests(clientPage);
  const automaticClientWorkspaceRequests: string[] = [];
  const cloneTriggeringClientPaths = new Set([
    `/api/projects/${firstProjectId}/framework`,
    `/api/projects/${firstProjectId}/publish-status`,
    `/api/projects/${firstProjectId}/sync-status`,
  ]);
  clientPage.on("request", (request) => {
    const url = new URL(request.url());
    if (
      cloneTriggeringClientPaths.has(url.pathname) ||
      (url.pathname === `/api/projects/${firstProjectId}/preview` && request.method() === "POST")
    ) {
      automaticClientWorkspaceRequests.push(`${request.method()} ${url.pathname}`);
    }
  });
  const clientErrors: string[] = [];
  clientPage.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location().url;
      clientErrors.push(`${message.text()}${location ? ` (${location})` : ""}`);
    }
  });
  clientPage.on("pageerror", (error) => clientErrors.push(error.message));

  await clientPage.goto(clientInvite.inviteLink);
  await expect(clientPage.getByRole("heading", { name: "Northstar Studio" })).toBeVisible();
  await expect(clientPage.getByLabel("Email")).toHaveValue(clientEmail);
  const clientCodeRequestedAt = Date.now();
  await clientPage.getByRole("button", { name: "Continue" }).click();
  const clientCode = await readDeliveredCode(clientEmail, clientCodeRequestedAt);
  await clientPage.getByLabel("6-digit code").fill(clientCode);
  await clientPage.getByRole("button", { name: "Sign in" }).click();
  await expect(clientPage).toHaveURL(new RegExp(`/p/${firstProjectId}$`));

  await clientPage.setViewportSize({ width: 390, height: 844 });
  const openMobilePreview = clientPage.getByRole("button", { name: "Open preview" });
  await expect(openMobilePreview).toBeVisible();
  await expect(clientPage.locator("dialog")).toHaveCount(0);
  await openMobilePreview.click();
  const previewDialog = clientPage.getByRole("dialog", { name: "Live preview" });
  await expect(previewDialog).toBeVisible();
  expect(await previewDialog.evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
  await clientPage.keyboard.press("Escape");
  await expect(previewDialog).toHaveCount(0);
  await expect(openMobilePreview).toBeFocused();

  const clientSession = await clientPage.request.get("/api/session");
  expect(clientSession.ok()).toBe(true);
  expect(await clientSession.json()).toMatchObject({
    kind: "client",
    projectId: firstProjectId,
    user: { email: clientEmail },
  });
  const clientProjects = await clientPage.request.get("/api/projects");
  expect(clientProjects.ok()).toBe(true);
  expect(await clientProjects.json()).toMatchObject({
    projects: [{ id: firstProjectId, role: "client" }],
  });
  expect((await clientPage.request.get(`/api/projects/${secondProjectId}`)).status()).toBe(404);
  expect((await clientPage.request.get(`/api/projects/${firstProjectId}/framework`)).status()).toBe(
    403,
  );
  expect(
    (await clientPage.request.get(`/api/projects/${firstProjectId}/sync-status`)).status(),
  ).toBe(403);
  expect(
    (
      await clientPage.request.post("/api/projects", {
        data: {
          name: "Forbidden client project",
          githubRepoFullName: "example/forbidden",
          defaultBranch: "main",
        },
      })
    ).status(),
  ).toBe(403);
  expect((await clientPage.request.get("/api/github/repos")).status()).toBe(403);
  expect(
    (await clientPage.request.get(`/api/team/projects/${firstProjectId}/members`)).status(),
  ).toBe(403);

  const deleteResponse = await page.request.delete(`/api/projects/${secondProjectId}`);
  expect(deleteResponse.status()).toBe(204);
  expect((await page.request.get(`/api/projects/${secondProjectId}`)).status()).toBe(404);

  expect([...collaboratorExternalHosts]).toEqual([]);
  expect(collaboratorErrors).toEqual([]);
  expect([...clientExternalHosts]).toEqual([]);
  expect(automaticClientWorkspaceRequests).toEqual([]);
  expect(clientErrors).toEqual([]);
  await collaboratorContext.close();
  await clientContext.close();

  expect([...unexpectedExternalHosts]).toEqual([]);
  expect(browserErrors).toEqual([]);
});
