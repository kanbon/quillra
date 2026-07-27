import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { previewBootHtml } from "./preview-boot.js";

type PreviewStage = "cloning" | "installing" | "starting";

type PollResponse = {
  stage: PreviewStage | "ready" | "error";
  label?: string;
  detail?: string;
};

class FakeClassList {
  private readonly values: Set<string>;

  constructor(...initial: string[]) {
    this.values = new Set(initial);
  }

  add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token);
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }
}

type FakeElement = {
  classList: FakeClassList;
  dataset: { stage?: PreviewStage };
  onclick?: (() => void) | null;
  textContent: string;
};

type PendingFetch = {
  resolve: (response: {
    ok: boolean;
    json: () => Promise<PollResponse>;
  }) => void;
  reject: (error: Error) => void;
};

type PendingTimer = {
  callback: () => void;
  delay: number;
  id: number;
};

function inlineScript(html: string): string {
  const match = /<script>\s*([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("Preview boot HTML did not contain an inline script.");
  return match[1];
}

async function flushPoll(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createHarness(
  options: { embedded?: boolean; editorUrl?: string; retryNonce?: string } = {},
) {
  const steps: FakeElement[] = (["cloning", "installing", "starting"] as const).map((stage) => ({
    classList: new FakeClassList("step"),
    dataset: { stage },
    textContent: "",
  }));
  const elements: Record<"detail" | "label" | "retry", FakeElement> = {
    detail: {
      classList: new FakeClassList("detail"),
      dataset: {},
      textContent: "Getting things ready…",
    },
    label: {
      classList: new FakeClassList(),
      dataset: {},
      textContent: "Starting your preview",
    },
    retry: {
      classList: new FakeClassList("retry", "hidden"),
      dataset: {},
      textContent: "Retry",
    },
  };

  const document = {
    getElementById(id: string): FakeElement | null {
      return elements[id as keyof typeof elements] ?? null;
    },
    querySelector(selector: string): FakeElement | null {
      if (selector !== ".step.active") return null;
      return steps.find((step) => step.classList.contains("active")) ?? null;
    },
    querySelectorAll(selector: string): FakeElement[] {
      return selector === ".step" ? steps : [];
    },
  };

  const pendingFetches: PendingFetch[] = [];
  const pendingTimers: PendingTimer[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let nextTimerId = 1;

  const fetchMock = vi.fn(() => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve: PendingFetch["resolve"], reject: PendingFetch["reject"]) => {
      pendingFetches.push({ resolve, reject });
    });
  });
  const setTimeoutMock = vi.fn((callback: () => void, delay: number) => {
    const id = nextTimerId;
    nextTimerId += 1;
    pendingTimers.push({ callback, delay, id });
    return id;
  });
  const clearTimeoutMock = vi.fn((id: number) => {
    const timerIndex = pendingTimers.findIndex((timer) => timer.id === id);
    if (timerIndex !== -1) pendingTimers.splice(timerIndex, 1);
  });
  const reload = vi.fn();
  const replace = vi.fn();
  const assign = vi.fn();
  const parentPostMessage = vi.fn();
  const retryNonce = options.retryNonce ?? "test-parent-nonce";
  const browserWindow: {
    location: {
      assign: typeof assign;
      href: string;
      reload: typeof reload;
      replace: typeof replace;
    };
    parent: unknown;
  } = {
    location: {
      assign,
      href: `https://preview.example.com/?__quillra_parent=${retryNonce}`,
      reload,
      replace,
    },
    parent: { postMessage: parentPostMessage },
  };
  if (options.embedded === false) browserWindow.parent = browserWindow;

  runInNewContext(
    inlineScript(
      previewBootHtml(4_321, "test-capability", undefined, undefined, options.editorUrl ?? ""),
    ),
    {
      clearTimeout: clearTimeoutMock,
      document,
      fetch: fetchMock,
      setTimeout: setTimeoutMock,
      URL,
      window: browserWindow,
    },
  );

  return {
    assign,
    clearTimeoutMock,
    clickRetry(): void {
      elements.retry.onclick?.();
    },
    elements,
    fetchMock,
    get inFlight(): number {
      return inFlight;
    },
    get maxInFlight(): number {
      return maxInFlight;
    },
    pendingTimerDelays(): number[] {
      return pendingTimers.map((timer) => timer.delay);
    },
    parentPostMessage,
    reload,
    replace,
    retryNonce,
    async respond(data: PollResponse): Promise<void> {
      const request = pendingFetches.shift();
      if (!request) throw new Error("There is no pending preview-status request.");
      inFlight -= 1;
      request.resolve({
        ok: true,
        json: async () => data,
      });
      await flushPoll();
    },
    async respondHttpError(): Promise<void> {
      const request = pendingFetches.shift();
      if (!request) throw new Error("There is no pending preview-status request.");
      inFlight -= 1;
      request.resolve({
        ok: false,
        json: async () => {
          throw new Error("An HTTP error response must not be parsed.");
        },
      });
      await flushPoll();
    },
    async respondNetworkError(): Promise<void> {
      const request = pendingFetches.shift();
      if (!request) throw new Error("There is no pending preview-status request.");
      inFlight -= 1;
      request.reject(new Error("Preview status network error"));
      await flushPoll();
    },
    runTimer(delay: number): void {
      const timerIndex = pendingTimers.findIndex((timer) => timer.delay === delay);
      if (timerIndex === -1) throw new Error(`There is no pending ${delay}ms timer.`);
      const [timer] = pendingTimers.splice(timerIndex, 1);
      timer?.callback();
    },
    steps,
  };
}

describe("preview boot document", () => {
  it("polls single-flight, progressively backs off during installs, and reloads when ready", async () => {
    const harness = createHarness();

    // The first request starts immediately. No timer exists while it is in
    // flight, so another status request cannot overlap it.
    expect(harness.fetchMock).toHaveBeenCalledOnce();
    expect(harness.inFlight).toBe(1);
    expect(harness.pendingTimerDelays()).toEqual([]);

    for (let completedPolls = 1; completedPolls <= 30; completedPolls += 1) {
      await harness.respond({
        stage: "installing",
        detail: "Installing dependencies",
      });

      expect(harness.inFlight).toBe(0);
      if (completedPolls < 30) {
        const delay = completedPolls >= 10 ? 2_000 : 1_000;
        expect(harness.pendingTimerDelays()).toEqual([delay]);
        harness.runTimer(delay);
        expect(harness.fetchMock).toHaveBeenCalledTimes(completedPolls + 1);
        expect(harness.inFlight).toBe(1);
        expect(harness.pendingTimerDelays()).toEqual([]);
      }
    }

    expect(harness.maxInFlight).toBe(1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(30);
    expect(harness.steps[1]?.classList.contains("active")).toBe(true);
    expect(harness.steps.every((step) => !step.classList.contains("failed"))).toBe(true);
    expect(harness.elements.retry.classList.contains("hidden")).toBe(true);
    expect(harness.elements.label.textContent).toMatch(/still setting things up/i);
    expect(harness.elements.detail.textContent).toBe("Installing dependencies");
    expect(harness.pendingTimerDelays()).toEqual([5_000]);

    harness.runTimer(5_000);
    expect(harness.fetchMock).toHaveBeenCalledTimes(31);
    expect(harness.inFlight).toBe(1);
    expect(harness.pendingTimerDelays()).toEqual([]);

    await harness.respond({
      stage: "installing",
      detail: "Downloading the remaining packages",
    });
    expect(harness.elements.detail.textContent).toBe("Downloading the remaining packages");
    expect(harness.pendingTimerDelays()).toEqual([5_000]);

    harness.runTimer(5_000);
    expect(harness.fetchMock).toHaveBeenCalledTimes(32);
    expect(harness.inFlight).toBe(1);
    expect(harness.pendingTimerDelays()).toEqual([]);

    await harness.respond({ stage: "ready" });

    expect(harness.inFlight).toBe(0);
    expect(harness.maxInFlight).toBe(1);
    expect(harness.steps.every((step) => step.classList.contains("done"))).toBe(true);
    expect(harness.steps.every((step) => !step.classList.contains("failed"))).toBe(true);
    expect(harness.pendingTimerDelays()).toEqual([50]);

    harness.runTimer(50);
    expect(harness.replace).toHaveBeenCalledWith("https://preview.example.com/");
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.fetchMock).toHaveBeenCalledTimes(32);
    expect(harness.pendingTimerDelays()).toEqual([]);
  });

  it("shows a retryable error after repeated HTTP and network failures", async () => {
    const harness = createHarness();

    for (let failure = 1; failure <= 5; failure += 1) {
      if (failure % 2 === 0) await harness.respondNetworkError();
      else await harness.respondHttpError();

      if (failure < 5) {
        expect(harness.pendingTimerDelays()).toEqual([1_500]);
        harness.runTimer(1_500);
      }
    }

    expect(harness.fetchMock).toHaveBeenCalledTimes(5);
    expect(harness.inFlight).toBe(0);
    expect(harness.pendingTimerDelays()).toEqual([]);
    expect(harness.elements.label.textContent).toBe("Preview status unavailable");
    expect(harness.elements.detail.textContent).toMatch(/could not check the preview status/i);
    expect(harness.elements.retry.classList.contains("hidden")).toBe(false);
    expect(harness.steps.filter((step) => step.classList.contains("failed"))).toHaveLength(1);
  });

  it("does not schedule another poll after a real backend error", async () => {
    const harness = createHarness();

    await harness.respond({
      stage: "installing",
      detail: "Installing dependencies",
    });
    harness.runTimer(1_000);
    await harness.respond({
      stage: "error",
      label: "Build failed",
      detail: "npm install exited with code 1",
    });

    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.maxInFlight).toBe(1);
    expect(harness.inFlight).toBe(0);
    expect(harness.pendingTimerDelays()).toEqual([]);
    expect(harness.elements.label.textContent).toBe("Build failed");
    expect(harness.elements.detail.textContent).toBe("npm install exited with code 1");
    expect(harness.elements.retry.classList.contains("hidden")).toBe(false);
    expect(harness.steps.filter((step) => step.classList.contains("failed"))).toHaveLength(1);
    expect(harness.steps[1]?.classList.contains("failed")).toBe(true);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("never moves the visible steps backward within one boot attempt", async () => {
    const harness = createHarness();

    await harness.respond({
      stage: "cloning",
      label: "Fetching your site",
      detail: "Fetching the project",
    });
    harness.runTimer(500);
    await harness.respond({
      stage: "starting",
      label: "Starting the preview",
      detail: "Opening the project",
    });

    expect(harness.steps[0]?.classList.contains("done")).toBe(true);
    expect(harness.steps[1]?.classList.contains("done")).toBe(true);
    expect(harness.steps[2]?.classList.contains("active")).toBe(true);
    expect(harness.pendingTimerDelays()).toEqual([250]);

    harness.runTimer(250);
    await harness.respond({
      stage: "installing",
      label: "Installing packages",
      detail: "This stale status must not move the UI backward",
    });

    expect(harness.steps[0]?.classList.contains("done")).toBe(true);
    expect(harness.steps[1]?.classList.contains("done")).toBe(true);
    expect(harness.steps[2]?.classList.contains("active")).toBe(true);
    expect(harness.elements.label.textContent).toBe("Starting the preview");
    expect(harness.elements.detail.textContent).toBe("Opening the project");
    expect(harness.pendingTimerDelays()).toEqual([250]);
  });

  it("reveals a warm preview within 300ms after it reaches the starting stage", async () => {
    const harness = createHarness();

    await harness.respond({
      stage: "starting",
      detail: "Waiting for the dev server",
    });
    expect(harness.pendingTimerDelays()).toEqual([250]);

    harness.runTimer(250);
    await harness.respond({ stage: "ready" });
    expect(harness.pendingTimerDelays()).toEqual([50]);

    harness.runTimer(50);
    expect(harness.replace).toHaveBeenCalledWith("https://preview.example.com/");
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.pendingTimerDelays()).toEqual([]);
  });

  it("asks the authorized editor parent for a fresh start when retry is selected", async () => {
    const harness = createHarness();

    await harness.respond({
      stage: "error",
      label: "Build failed",
      detail: "Dependency installation failed",
    });
    harness.clickRetry();

    expect(harness.parentPostMessage).toHaveBeenCalledWith(
      { type: "quillra:retry-preview", nonce: harness.retryNonce },
      "*",
    );
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.elements.retry.classList.contains("hidden")).toBe(true);
    expect(harness.elements.label.textContent).toBe("Retrying your preview");
    expect(harness.pendingTimerDelays()).toEqual([750]);

    harness.runTimer(750);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    await harness.respond({
      stage: "cloning",
      detail: "Fetching the project",
    });
    expect(harness.steps[0]?.classList.contains("active")).toBe(true);
    expect(harness.elements.detail.textContent).toBe("Fetching the project");
  });

  it("returns a standalone preview to its authorized editor for a real restart", async () => {
    const editorUrl = "https://cms.example.com/p/project-1";
    const harness = createHarness({ embedded: false, editorUrl });

    await harness.respond({
      stage: "error",
      label: "Build failed",
      detail: "Dependency installation failed",
    });

    expect(harness.elements.retry.textContent).toBe("Return to Quillra");
    harness.clickRetry();

    expect(harness.assign).toHaveBeenCalledWith(editorUrl);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.parentPostMessage).not.toHaveBeenCalled();
  });
});
