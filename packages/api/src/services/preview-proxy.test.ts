import { describe, expect, it } from "vitest";
import {
  PREVIEW_REWRITE_MAX_BYTES,
  rewritePreviewResourcePaths,
  sanitizeHostPreviewRequestHeaders,
  sanitizePreviewRequestHeaders,
  secureHostPreviewResponseHeaders,
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

  it("consumes the gateway cookie while preserving unrelated project cookies", () => {
    const headers = sanitizeHostPreviewRequestHeaders(
      new Headers({
        authorization: "Bearer control-secret",
        cookie:
          "__Host-quillra_preview=cap; quillra_team_session=control; project_session=site-value",
        "x-forwarded-for": "203.0.113.1",
      }),
      "__Host-quillra_preview",
    );

    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("cookie")).toBe("project_session=site-value");
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

  it("keeps project cookies host-only and rejects control-plane cookie names", () => {
    const upstream = new Headers();
    upstream.append("set-cookie", "project_session=value; Domain=example.net; Path=/; HttpOnly");
    upstream.append("set-cookie", "quillra_team_session=forged; Domain=example.net; Path=/");

    const headers = secureHostPreviewResponseHeaders(
      upstream,
      "https://p-deadbeef.preview.example.net/",
      4_321,
      ["https://cms.example.com"],
      "__Host-quillra_preview",
    );
    const cookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    expect(cookies).toEqual(["project_session=value; Path=/; HttpOnly"]);
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

    const e2bRedirect = securePreviewResponseHeaders(
      new Headers({ location: "https://4321-sandbox.e2b.app/private?next=1" }),
      `https://quillra.example${PREVIEW_ROOT}`,
      4_321,
      CAPABILITY,
      "https://4321-sandbox.e2b.app",
    );
    expect(e2bRedirect.get("location")).toBe(`${PREVIEW_ROOT}private?next=1`);
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

  it("rejects oversized rewrite bodies without buffering them", async () => {
    const upstream = new Response("small body", {
      headers: {
        "content-length": String(PREVIEW_REWRITE_MAX_BYTES + 1),
        "content-type": "text/html",
      },
    });

    const rewritten = await rewritePreviewResourcePaths(upstream, 4_321, CAPABILITY);
    expect(rewritten.status).toBe(502);
    await expect(rewritten.text()).resolves.toContain("safe proxy limit");
  });

  it("keeps host-preview paths native and allows framing only from control origins", () => {
    const publicUrl = "https://p-deadbeef.preview.example.net/dashboard?tab=one";
    const headers = secureHostPreviewResponseHeaders(
      new Headers({
        location: "/login?next=%2Fdashboard#form",
        "set-cookie": "upstream=unsafe; Domain=example.net",
        "x-frame-options": "DENY",
      }),
      publicUrl,
      4_321,
      ["https://cms.example.com", "https://edit.example.com"],
    );

    expect(headers.get("location")).toBe("/login?next=%2Fdashboard#form");
    expect(headers.get("set-cookie")).toBe("upstream=unsafe");
    expect(headers.get("x-frame-options")).toBeNull();
    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toContain(
      "sandbox allow-scripts allow-forms allow-modals allow-downloads allow-same-origin",
    );
    expect(csp).toContain("frame-ancestors https://cms.example.com https://edit.example.com");
    expect(csp).toContain("connect-src 'self' wss://p-deadbeef.preview.example.net");
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it("rewrites only loopback redirects in host mode", () => {
    const publicUrl = "https://p-deadbeef.preview.example.net/account";
    const loopback = secureHostPreviewResponseHeaders(
      new Headers({ location: "http://127.0.0.1:4321/login?from=account" }),
      publicUrl,
      4_321,
      ["https://cms.example.com"],
    );
    expect(loopback.get("location")).toBe(
      "https://p-deadbeef.preview.example.net/login?from=account",
    );

    const external = secureHostPreviewResponseHeaders(
      new Headers({ location: "https://accounts.example.org/login" }),
      publicUrl,
      4_321,
      ["https://cms.example.com"],
    );
    expect(external.get("location")).toBe("https://accounts.example.org/login");

    const e2b = secureHostPreviewResponseHeaders(
      new Headers({ location: "https://4321-sandbox.e2b.app/login" }),
      publicUrl,
      4_321,
      ["https://cms.example.com"],
      "__Host-quillra_preview",
      "https://4321-sandbox.e2b.app",
    );
    expect(e2b.get("location")).toBe("https://p-deadbeef.preview.example.net/login");

    const controlPlane = secureHostPreviewResponseHeaders(
      new Headers({ location: "https://cms.example.com/api/session" }),
      publicUrl,
      4_321,
      ["https://cms.example.com"],
    );
    expect(controlPlane.get("location")).toBeNull();

    const unsafe = secureHostPreviewResponseHeaders(
      new Headers({ location: "javascript:alert(1)" }),
      publicUrl,
      4_321,
      ["https://cms.example.com"],
    );
    expect(unsafe.get("location")).toBeNull();
  });
});
