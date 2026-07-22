import { describe, expect, it } from "vitest";
import {
  rewritePreviewResourcePaths,
  sanitizePreviewRequestHeaders,
  securePreviewResponseHeaders,
} from "./preview-proxy.js";

const CAPABILITY = "abcdefghijklmnopqrstuvwxyzABCDEF";
const PREVIEW_ROOT = `/__preview/4321/${CAPABILITY}/`;

describe("preview proxy isolation", () => {
  it("does not forward Quillra credentials or proxy identity headers", () => {
    const headers = sanitizePreviewRequestHeaders(
      new Headers({
        accept: "text/html",
        authorization: "Bearer app-secret",
        "cf-connecting-ip": "203.0.113.1",
        "cf-ray": "proxy-request-id",
        cookie: "quillra_team_session=secret",
        forwarded: "for=203.0.113.1",
        host: "quillra.example",
        origin: "https://quillra.example",
        referer: "https://quillra.example/private",
        "x-forwarded-for": "203.0.113.1",
        "x-quillra-internal": "secret",
        "x-real-ip": "203.0.113.1",
      }),
    );

    expect(Object.fromEntries(headers)).toEqual({ accept: "text/html" });
  });

  it("strips state-changing response headers and applies a strict sandbox", () => {
    const headers = securePreviewResponseHeaders(
      new Headers({
        "access-control-allow-credentials": "true",
        "clear-site-data": '"cookies"',
        "content-security-policy": "default-src *",
        "service-worker-allowed": "/",
        "set-cookie": "app_session=stolen; Path=/",
      }),
      `https://quillra.example${PREVIEW_ROOT}`,
      4_321,
      CAPABILITY,
    );

    expect(headers.get("clear-site-data")).toBeNull();
    expect(headers.get("access-control-allow-credentials")).toBeNull();
    expect(headers.get("service-worker-allowed")).toBeNull();
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("access-control-allow-origin")).toBe("null");

    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts allow-forms allow-modals allow-downloads");
    expect(csp).toContain(`form-action https://quillra.example${PREVIEW_ROOT}`);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-top-navigation");
  });

  it("keeps redirects and preload links inside the guarded preview path", () => {
    const rootRedirect = securePreviewResponseHeaders(
      new Headers({ location: "/login", link: "</assets/app.js>; rel=preload" }),
      `https://quillra.example${PREVIEW_ROOT}`,
      4_321,
      CAPABILITY,
    );
    expect(rootRedirect.get("location")).toBe(`${PREVIEW_ROOT}login`);
    expect(rootRedirect.get("link")).toBe(`<${PREVIEW_ROOT}assets/app.js>; rel=preload`);

    const internalRedirect = securePreviewResponseHeaders(
      new Headers({ location: "http://127.0.0.1:4321/account?next=%2F" }),
      `https://quillra.example${PREVIEW_ROOT}`,
      4_321,
      CAPABILITY,
    );
    expect(internalRedirect.get("location")).toBe(`${PREVIEW_ROOT}account?next=%2F`);

    const traversingRedirect = securePreviewResponseHeaders(
      new Headers({ location: "../../../api/session" }),
      `https://quillra.example${PREVIEW_ROOT}nested/page`,
      4_321,
      CAPABILITY,
    );
    expect(traversingRedirect.get("location")).toBe(`${PREVIEW_ROOT}api/session`);

    const unsafeRedirect = securePreviewResponseHeaders(
      new Headers({ location: "javascript:alert(1)" }),
      `https://quillra.example${PREVIEW_ROOT}`,
      4_321,
      CAPABILITY,
    );
    expect(unsafeRedirect.get("location")).toBeNull();
  });

  it("scopes root-relative HTML and module paths without changing external URLs", async () => {
    const upstream = new Response(
      '<script src="/src/main.ts"></script><img src="https://cdn.example/logo.svg">' +
        '<img src=/local.svg><div style="background:url(/hero.png)"></div>' +
        '<script>fetch("/api/items"); import "/@vite/client";</script>',
      {
        headers: {
          "content-encoding": "gzip",
          "content-length": "999",
          "content-type": "text/html; charset=utf-8",
        },
      },
    );

    const rewritten = await rewritePreviewResourcePaths(upstream, 4_321, CAPABILITY);
    await expect(rewritten.text()).resolves.toBe(
      `<script src="${PREVIEW_ROOT}src/main.ts"></script><img src="https://cdn.example/logo.svg"><img src=${PREVIEW_ROOT}local.svg><div style="background:url(${PREVIEW_ROOT}hero.png)"></div><script>fetch("${PREVIEW_ROOT}api/items"); import "${PREVIEW_ROOT}@vite/client";</script>`,
    );
    expect(rewritten.headers.get("content-encoding")).toBeNull();
    expect(rewritten.headers.get("content-length")).toBeNull();
  });
});
