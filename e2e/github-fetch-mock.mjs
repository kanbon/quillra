/**
 * Deterministic GitHub boundary for the production E2E process.
 *
 * The application still runs its real OAuth state/PKCE handling, encrypted
 * user connection storage, repository intersection checks, and branch
 * verification. Only requests that would leave the test process for GitHub
 * are replaced with the fixture responses below. Unexpected GitHub requests
 * fail loudly so a new production call cannot silently escape the fixture.
 */

const originalFetch = globalThis.fetch.bind(globalThis);
const oauthCode = "quillra-e2e-oauth-code";
const oauthClientId = "Iv1.quillra-e2e";
const oauthClientSecret = "quillra-e2e-client-secret";
const userAccessToken = "quillra-e2e-user-access-token";
const installationId = 11;

const repositories = [
  {
    id: 101,
    full_name: "example/site-one",
    default_branch: "main",
    permissions: { admin: false, push: true, pull: true },
  },
  {
    id: 102,
    full_name: "example/site-two",
    default_branch: "main",
    permissions: { admin: true, push: true, pull: true },
  },
];

function fail(message) {
  throw new Error(`[e2e-github] ${message}`);
}

function requestParts(input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return { url, method, headers };
}

async function requestBody(input, init) {
  if (init?.body !== undefined && init.body !== null) return String(init.body);
  if (input instanceof Request) return input.clone().text();
  return "";
}

function assertBearer(headers, expected = userAccessToken) {
  if (headers.get("authorization") !== `Bearer ${expected}`) {
    fail("GitHub API request did not use the expected scoped credential");
  }
}

function findRepository(pathname) {
  return repositories.find(
    (repository) => `/repos/${repository.full_name}` === pathname.replace(/\/branches$/, ""),
  );
}

globalThis.fetch = async (input, init) => {
  const { url, method, headers } = requestParts(input, init);

  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
    if (method !== "POST") fail(`OAuth token exchange used ${method}`);
    const body = new URLSearchParams(await requestBody(input, init));
    if (body.get("client_id") !== oauthClientId) fail("OAuth token exchange used the wrong client");
    if (body.get("client_secret") !== oauthClientSecret) {
      fail("OAuth token exchange used the wrong client secret");
    }
    if (body.get("code") !== oauthCode) fail("OAuth token exchange used an unexpected code");
    if ((body.get("code_verifier")?.length ?? 0) < 43) {
      fail("OAuth token exchange omitted the PKCE verifier");
    }
    if (!body.get("redirect_uri")?.endsWith("/api/github/connect/callback")) {
      fail("OAuth token exchange used an unexpected callback");
    }
    return Response.json({
      access_token: userAccessToken,
      expires_in: 28_800,
      refresh_token: "quillra-e2e-user-refresh-token",
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
    });
  }

  if (url.origin !== "https://api.github.com") {
    return originalFetch(input, init);
  }

  if (method === "GET" && url.pathname === "/user") {
    assertBearer(headers);
    return Response.json({ id: 7_001, login: "quillra-e2e-owner" });
  }

  if (method === "GET" && url.pathname === "/user/installations") {
    assertBearer(headers);
    return Response.json({
      installations: [{ id: installationId, permissions: { contents: "write" } }],
    });
  }

  if (method === "GET" && url.pathname === `/user/installations/${installationId}`) {
    assertBearer(headers);
    return Response.json({ id: installationId, permissions: { contents: "write" } });
  }

  if (method === "GET" && url.pathname === `/user/installations/${installationId}/repositories`) {
    assertBearer(headers);
    return Response.json({ repositories });
  }

  const repository = findRepository(url.pathname);
  if (method === "GET" && repository && url.pathname.endsWith("/branches")) {
    assertBearer(headers);
    return Response.json([{ name: repository.default_branch }]);
  }

  if (method === "GET" && repository && url.pathname === `/repos/${repository.full_name}`) {
    assertBearer(headers);
    return Response.json({ default_branch: repository.default_branch });
  }

  if (method === "POST" && url.pathname === `/app/installations/${installationId}/access_tokens`) {
    const body = JSON.parse(await requestBody(input, init));
    const repositoryId = body.repository_ids?.[0];
    if (
      body.repository_ids?.length !== 1 ||
      !repositories.some((candidate) => candidate.id === repositoryId)
    ) {
      fail("Installation token was not limited to one fixture repository");
    }
    if (body.permissions?.contents !== "read" && body.permissions?.contents !== "write") {
      fail("Installation token requested unexpected permissions");
    }
    if (!headers.get("authorization")?.startsWith("Bearer eyJ")) {
      fail("Installation token mint did not use a GitHub App JWT");
    }
    return Response.json({
      token: `quillra-e2e-installation-${repositoryId}-${body.permissions.contents}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
  }

  if (method === "GET" && url.pathname === "/installation/repositories") {
    const token = headers.get("authorization")?.replace(/^Bearer /, "");
    const repositoryId = Number(token?.split("-").at(-2));
    const scopedRepository = repositories.find((candidate) => candidate.id === repositoryId);
    if (!scopedRepository) fail("Repository verification used an unknown installation token");
    return Response.json({ repositories: [scopedRepository] });
  }

  fail(`Unexpected GitHub request: ${method} ${url.pathname}${url.search}`);
};
