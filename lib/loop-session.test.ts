import { describe, test, expect, vi } from "bun:test";
import { WebLoopController } from "./loop-session";

function harness() {
  const submissions: string[] = [];
  const stopped = Promise.withResolvers<void>();
  let busy = false;
  const controller = new WebLoopController({
    busy: () => busy,
    submit: async (text) => { submissions.push(text); },
    changed: (state) => { if (!state.enabled) stopped.resolve(); },
    conditionOptions: () => ({ cwd: process.cwd(), sessionId: "web-loop-test", timeoutMs: 2000 }),
  });
  return { controller, submissions, stopped: stopped.promise, setBusy: (value: boolean) => { busy = value; } };
}

describe("web loop lifecycle", () => {
  test("counts the first prompt, then stops at the requested total", () => {
    const { controller, submissions } = harness();
    vi.useFakeTimers();
    try {
      expect(controller.toggle("2 say ok")).toBe("say ok");
      controller.capture("say ok");
      controller.settled();
      controller.settled();
      vi.advanceTimersByTime(800);
      expect(submissions).toEqual(["say ok"]);
      expect(controller.info.iterations).toBe(2);
      controller.settled();
      vi.advanceTimersByTime(800);
      expect(controller.info.enabled).toBe(false);
      expect(submissions).toHaveLength(1);
    } finally { controller.dispose(); vi.useRealTimers(); }
  });

  test("abort cancels pending continuation and the next user prompt resumes", () => {
    const { controller, submissions } = harness();
    vi.useFakeTimers();
    try {
      controller.toggle("3");
      controller.capture("first");
      controller.settled();
      controller.pause();
      vi.advanceTimersByTime(800);
      expect(submissions).toHaveLength(0);
      expect(controller.info.status).toBe("paused");
      controller.capture("replacement");
      expect(controller.info.prompt).toBe("replacement");
      expect(controller.info.status).toBe("running");
      controller.toggle("");
      expect(controller.info.enabled).toBe(false);
    } finally { controller.dispose(); vi.useRealTimers(); }
  });

  test("until true gates continuation, never the initial turn", async () => {
    const { controller, submissions, stopped } = harness();
    vi.useFakeTimers();
    try {
      controller.toggle("--until 'true' say ok");
      controller.capture("say ok");
      controller.settled();
      vi.advanceTimersByTime(800);
      vi.useRealTimers();
      await stopped;
      expect(controller.info.enabled).toBe(false);
      expect(controller.info.iterations).toBe(1);
      expect(submissions).toHaveLength(0);
    } finally { controller.dispose(); vi.useRealTimers(); }
  });

  test("busy sessions defer without spending another iteration", () => {
    const { controller, submissions, setBusy } = harness();
    vi.useFakeTimers();
    try {
      controller.toggle("2");
      controller.capture("hello");
      setBusy(true);
      controller.settled();
      vi.advanceTimersByTime(800);
      expect(controller.info.iterations).toBe(1);
      expect(submissions).toHaveLength(0);
      setBusy(false);
      vi.advanceTimersByTime(800);
      expect(submissions).toEqual(["hello"]);
    } finally { controller.dispose(); vi.useRealTimers(); }
  });
});
