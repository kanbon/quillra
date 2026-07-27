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
  textContent: string;
};

type PendingFetch = {
  resolve: (response: {
    ok: boolean;
    json: () => Promise<PollResponse>;
  }) => void;
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

function createHarness() {
  const steps: FakeElement[] = (["cloning", "installing", "starting"] as const).map((stage) => ({
    classList: new FakeClassList("step"),
    dataset: { stage },
    textContent: "",
  }));
  const elements = {
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
  } satisfies Record<string, FakeElement>;

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
    return new Promise((resolve: PendingFetch["resolve"]) => {
      pendingFetches.push({ resolve });
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

  runInNewContext(inlineScript(previewBootHtml(4_321, "test-capability")), {
    clearTimeout: clearTimeoutMock,
    document,
    fetch: fetchMock,
    setTimeout: setTimeoutMock,
    window: { location: { reload } },
  });

  return {
    clearTimeoutMock,
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
    reload,
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
  it("polls single-flight, backs off after 30 installing responses, and reloads when ready", async () => {
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
        expect(harness.pendingTimerDelays()).toEqual([1_500]);
        harness.runTimer(1_500);
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
    expect(`${harness.elements.label.textContent} ${harness.elements.detail.textContent}`).toMatch(
      /still setting things up.*first setup can take a few minutes/i,
    );
    expect(harness.pendingTimerDelays()).toEqual([5_000]);

    harness.runTimer(5_000);
    expect(harness.fetchMock).toHaveBeenCalledTimes(31);
    expect(harness.inFlight).toBe(1);
    expect(harness.pendingTimerDelays()).toEqual([]);

    await harness.respond({ stage: "ready" });

    expect(harness.inFlight).toBe(0);
    expect(harness.maxInFlight).toBe(1);
    expect(harness.steps.every((step) => step.classList.contains("done"))).toBe(true);
    expect(harness.steps.every((step) => !step.classList.contains("failed"))).toBe(true);
    expect(harness.pendingTimerDelays()).toEqual([400]);

    harness.runTimer(400);
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(harness.fetchMock).toHaveBeenCalledTimes(31);
    expect(harness.pendingTimerDelays()).toEqual([]);
  });

  it("does not schedule another poll after a real backend error", async () => {
    const harness = createHarness();

    await harness.respond({
      stage: "installing",
      detail: "Installing dependencies",
    });
    harness.runTimer(1_500);
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
});
