import {
  consumeLoopLimitIteration,
  createLoopLimitRuntime,
  isLoopLimitExhausted,
  parseLoopArgs,
} from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import { evaluateLoopCondition } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import type { WebLoopInfo } from "./loop-web";

/** The TUI's repeat-after-yield state machine; parsing, budgets and shell gates stay in the SDK. */
export class WebLoopController {
  private state: WebLoopInfo = { enabled: false, status: "waiting", iterations: 0 };
  private timer?: ReturnType<typeof setTimeout>;
  private conditionAbort?: AbortController;
  private generation = 0;

  constructor(private readonly host: {
    busy: () => boolean;
    submit: (prompt: string) => Promise<unknown>;
    changed: (state: WebLoopInfo) => void;
    conditionOptions: () => { cwd: string; sessionId: string; timeoutMs: number };
  }) {}

  get info(): WebLoopInfo {
    return { ...this.state, ...(this.state.limit ? { limit: { ...this.state.limit } } : {}) };
  }

  get pending(): boolean {
    return !!this.timer || !!this.conditionAbort;
  }

  toggle(args: string): string | undefined {
    if (this.state.enabled) {
      this.disable();
      return;
    }
    const parsed = parseLoopArgs(args);
    if (typeof parsed === "string") throw new Error(parsed);
    this.cancel();
    this.state = {
      enabled: true, status: "waiting", iterations: 0,
      limit: createLoopLimitRuntime(parsed.limit), condition: parsed.condition,
    };
    this.publish();
    return parsed.prompt;
  }

  /** The initial user turn counts toward the requested total, and always bypasses the condition. */
  capture(prompt: string): void {
    if (!this.state.enabled) return;
    this.cancel();
    if (!consumeLoopLimitIteration(this.state.limit)) {
      this.disable("limit");
      return;
    }
    this.state = { ...this.state, prompt, status: "running", iterations: this.state.iterations + 1 };
    this.publish();
  }

  pause(): void {
    if (!this.state.enabled) return;
    this.cancel();
    this.state = { ...this.state, prompt: undefined, status: "paused" };
    this.publish();
  }

  disable(reason?: string): void {
    this.cancel();
    this.state = { enabled: false, status: "waiting", iterations: this.state.iterations, reason };
    this.publish();
  }

  settled(): void {
    if (!this.state.enabled || !this.state.prompt || this.state.status === "paused" || this.pending) return;
    const generation = this.generation;
    // Match the TUI's interruption window between turns.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.continue(generation).catch((error) => {
        if (generation === this.generation) this.disable(error instanceof Error ? error.message : String(error));
      });
    }, 800);
  }

  dispose(): void {
    this.cancel();
  }

  private async continue(generation: number): Promise<void> {
    if (generation !== this.generation || !this.state.enabled || !this.state.prompt) return;
    if (this.host.busy()) {
      this.settled();
      return;
    }
    if (isLoopLimitExhausted(this.state.limit)) {
      this.disable("limit");
      return;
    }
    if (this.state.condition) {
      const controller = new AbortController();
      this.conditionAbort = controller;
      let verdict;
      try {
        verdict = await evaluateLoopCondition(this.state.condition, { ...this.host.conditionOptions(), signal: controller.signal });
      } finally {
        if (this.conditionAbort === controller) this.conditionAbort = undefined;
      }
      if (generation !== this.generation) return;
      if (verdict.kind === "aborted") return;
      if (verdict.kind !== "continue") {
        this.disable(verdict.message);
        return;
      }
    }
    if (generation !== this.generation) return;
    if (this.host.busy()) {
      this.settled();
      return;
    }
    if (!consumeLoopLimitIteration(this.state.limit)) {
      this.disable("limit");
      return;
    }
    this.state.iterations++;
    this.publish();
    await this.host.submit(this.state.prompt!);
  }

  private cancel(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.conditionAbort?.abort();
    this.conditionAbort = undefined;
  }

  private publish(): void {
    this.host.changed(this.info);
  }
}
