import type { SessionEvent } from "./session-events";

type Schedule = (callback: () => void, delayMs: number) => () => void;
const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/** Bound cumulative tool output on each SSE connection; SDK projections remain immediate. */
export function createToolUpdateThrottle(send: (event: SessionEvent) => void, schedule: Schedule = scheduleTimeout) {
  const pending = new Map<string, { event: SessionEvent; cancel: () => void }>();
  const ended = new Set<string>();
  let disposed = false;

  return {
    push(event: SessionEvent) {
      if (disposed) return;
      const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (event.type === "tool_execution_update" && id) {
        if (ended.has(id)) return;
        const previous = pending.get(id);
        if (previous) {
          previous.event = event;
          return;
        }
        const frame = {
          event,
          cancel: schedule(() => {
            pending.delete(id);
            if (!disposed) send(frame.event);
          }, 250),
        };
        pending.set(id, frame);
        return;
      }
      if (event.type === "tool_execution_end" && id) {
        pending.get(id)?.cancel();
        pending.delete(id);
        ended.add(id);
      } else if (event.type === "tool_execution_start" && id) {
        ended.delete(id);
      }
      send(event);
    },
    dispose() {
      disposed = true;
      for (const frame of pending.values()) frame.cancel();
      pending.clear();
      ended.clear();
    },
  };
}
