import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const basePort = Number(process.env.QUILLRA_E2E_PORT ?? "3417");
const gatewayPort = basePort + 10;
const upstreamPort = basePort + 11;
const parentPort = basePort + 12;
const statePath = path.join(tmpdir(), `quillra-preview-e2e-${basePort}.json`);

let fixture: ChildProcess | null = null;
let parentUrl = "";

test.beforeAll(async () => {
  rmSync(statePath, { force: true });
  fixture = spawn(
    process.execPath,
    [
      "packages/api/e2e/preview-fixture.mjs",
      String(gatewayPort),
      String(upstreamPort),
      String(parentPort),
      statePath,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let fixtureError = "";
  fixture.stderr?.on("data", (chunk) => {
    fixtureError += chunk.toString();
  });

  await expect
    .poll(
      () => {
        if (fixture?.exitCode !== null) {
          throw new Error(`Preview fixture exited early: ${fixtureError}`);
        }
        return existsSync(statePath);
      },
      { timeout: 10_000, message: "Expected preview fixture to start" },
    )
    .toBe(true);
  parentUrl = (JSON.parse(readFileSync(statePath, "utf8")) as { parentUrl: string }).parentUrl;
});

test.afterAll(async () => {
  const child = fixture;
  fixture = null;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(resolve, 3_000).unref();
    });
  }
  rmSync(statePath, { force: true });
});

test("preview host preserves SPA routing, root assets, API calls, and Vite HMR", async ({
  page,
  request,
}) => {
  await page.goto(parentUrl);
  const frame = page.frame({ name: "preview" });
  expect(frame).not.toBeNull();
  if (!frame) return;

  await expect(frame.getByTestId("route")).toHaveText("Home route");
  await expect(frame.getByTestId("asset")).toHaveText("root asset loaded");
  await expect(frame.getByTestId("api")).toHaveText("root API loaded");
  await expect(frame.getByTestId("post")).toHaveText("POST:browser:exact-post-body");
  await expect(frame.getByTestId("worker")).toHaveText("dedicated worker loaded");
  await expect(frame.getByTestId("hmr")).toHaveText("vite-hmr connected");
  await expect
    .poll(() => frame.getByTestId("logo").evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);

  const cleanUrl = new URL(frame.url());
  expect(cleanUrl.hostname).toMatch(/^p-[a-f0-9]{40}\.localhost$/);
  expect(cleanUrl.pathname).toBe("/");
  expect(cleanUrl.searchParams.has("__quillra_preview")).toBe(false);

  await frame.getByTestId("beratung-link").click();
  await expect(frame.getByTestId("route")).toHaveText("Beratung route");
  await expect.poll(() => new URL(frame.url()).pathname).toBe("/beratung");
  expect(new URL(frame.url()).search).toBe("?from=client");
  expect(new URL(frame.url()).hash).toBe("#details");

  await Promise.all([frame.waitForNavigation(), frame.evaluate(() => window.location.reload())]);
  await expect(frame.getByTestId("route")).toHaveText("Beratung route");
  expect(new URL(frame.url()).pathname).toBe("/beratung");

  await frame.goto(`${cleanUrl.origin}/redirect`);
  await expect(frame.getByTestId("route")).toHaveText("Beratung route");
  expect(new URL(frame.url()).pathname).toBe("/beratung");
  expect(new URL(frame.url()).search).toBe("?from=redirect");

  const serviceWorkerResult = await frame.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    try {
      await navigator.serviceWorker.register("/sw.js");
      return "registered";
    } catch {
      return "blocked";
    }
  });
  expect(serviceWorkerResult).not.toBe("registered");

  const state = (await (
    await request.get(`http://localhost:${gatewayPort}/fixture-state`)
  ).json()) as {
    handoffUrl: string;
    requests: Array<{
      method: string;
      url: string;
      body: string;
      cookie: string;
      acceptEncoding: string;
      trafficToken: string;
      serviceWorker: string;
    }>;
  };
  const replay = await request.get(state.handoffUrl, { maxRedirects: 0 });
  expect(replay.status()).toBe(404);
  expect(await replay.text()).toBe("Preview not found");

  expect(state.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: "GET", url: "/asset.js?build=browser" }),
      expect.objectContaining({ method: "GET", url: "/api/data?source=browser" }),
      expect.objectContaining({ method: "GET", url: "/logo.svg?asset=root" }),
      expect.objectContaining({ method: "GET", url: "/worker.js?worker=root" }),
      expect.objectContaining({
        method: "POST",
        url: "/api/echo?source=browser",
        body: "exact-post-body",
      }),
      expect.objectContaining({ method: "WS", url: "/hmr?channel=browser" }),
      expect.objectContaining({ method: "GET", url: "/beratung?from=client" }),
    ]),
  );
  expect(state.requests.every((entry) => !entry.cookie.includes("quillra_preview"))).toBe(true);
  expect(
    state.requests.every((entry) => entry.trafficToken === "preview-fixture-traffic-token"),
  ).toBe(true);
  expect(
    state.requests
      .filter((entry) => entry.method !== "WS")
      .every((entry) => entry.acceptEncoding === "identity"),
  ).toBe(true);

  const crossSiteChatOpened = await page.evaluate(
    (controlPort) =>
      new Promise<boolean>((resolve) => {
        const websocket = new WebSocket(`ws://localhost:${controlPort}/ws/chat/not-authorized`);
        let opened = false;
        const finish = () => resolve(opened);
        websocket.addEventListener("open", () => {
          opened = true;
          websocket.close();
        });
        websocket.addEventListener("close", finish, { once: true });
        websocket.addEventListener("error", () => setTimeout(finish, 0), { once: true });
        setTimeout(finish, 2_000);
      }),
    basePort,
  );
  expect(crossSiteChatOpened).toBe(false);

  const revoke = await request.post(`http://localhost:${gatewayPort}/fixture-revoke`);
  expect(revoke.ok()).toBe(true);
  const denied = await frame.goto(`${cleanUrl.origin}/after-revoke`);
  expect(denied?.status()).toBe(404);
  await expect(frame.locator("body")).toHaveText("Preview not found");
});
