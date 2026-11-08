import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolUpdateThrottle } from "./agent-event-throttle";
import type { SessionEvent } from "./session-events";

function fixture() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const sent: SessionEvent[] = [];
  const throttle = createToolUpdateThrottle((event) => sent.push(event), (callback, delayMs) => {
    const id = ++nextId;
    timers.set(id, { at: now + delayMs, callback });
    return () => { timers.delete(id); };
  });
  return {
    throttle, timers, sent,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function update(id: string, text: string): SessionEvent {
  return { type: "tool_execution_update", toolCallId: id, toolName: "bash", partialResult: { content: [{ type: "text", text }] } };
}

test("cumulative updates coalesce to the latest snapshot at most once per 250ms", () => {
  const { throttle, timers, sent, advance } = fixture();
  throttle.push(update("a", "first"));
  advance(100);
  const latest = update("a", "first and second");
  throttle.push(latest);
  assert.equal(timers.size, 1);
  advance(149);
  assert.deepEqual(sent, []);
  advance(1);
  assert.deepEqual(sent, [latest]);
  const next = update("a", "third snapshot");
  throttle.push(next);
  advance(249);
  assert.deepEqual(sent, [latest]);
  advance(1);
  assert.deepEqual(sent, [latest, next]);
});

test("each toolCallId retains its own latest snapshot and deadline", () => {
  const { throttle, sent, advance } = fixture();
  const a = update("a", "a");
  const b = update("b", "b");
  throttle.push(a);
  advance(100);
  throttle.push(b);
  advance(150);
  assert.deepEqual(sent, [a]);
  advance(100);
  assert.deepEqual(sent, [a, b]);
});

test("tool end drops its pending snapshot and no update is emitted after end", () => {
  const { throttle, timers, sent, advance } = fixture();
  throttle.push(update("a", "stale"));
  const b = update("b", "still running");
  throttle.push(b);
  const end = { type: "tool_execution_end", toolCallId: "a" };
  throttle.push(end);
  assert.deepEqual(sent, [end]);
  assert.equal(timers.size, 1);
  throttle.push(update("a", "late"));
  advance(1000);
  assert.deepEqual(sent, [end, b]);
  assert.equal(timers.size, 0);
});

test("tool_stream_update and other SDK events bypass cumulative-output throttling", () => {
  const { throttle, timers, sent } = fixture();
  const projection = { type: "tool_stream_update", toolCallId: "a", update: { files: [{ path: "a.ts", diff: "+line" }] } };
  const notice = { type: "notice", message: "message" };
  throttle.push(update("a", "queued"));
  throttle.push(projection);
  throttle.push(notice);
  assert.deepEqual(sent, [projection, notice]);
  assert.equal(timers.size, 1);
});

test("connection disposal clears every timer and prevents subsequent sends", () => {
  const { throttle, timers, sent, advance } = fixture();
  throttle.push(update("a", "pending a"));
  throttle.push(update("b", "pending b"));
  assert.equal(timers.size, 2);
  throttle.dispose();
  throttle.dispose();
  assert.equal(timers.size, 0);
  advance(1000);
  throttle.push(update("c", "after close"));
  throttle.push({ type: "tool_execution_end", toolCallId: "b" });
  assert.deepEqual(sent, []);
  assert.equal(timers.size, 0);
});

test("an explicit tool start permits a reused call id", () => {
  const { throttle, sent, advance } = fixture();
  const end = { type: "tool_execution_end", toolCallId: "a" };
  const start = { type: "tool_execution_start", toolCallId: "a" };
  const fresh = update("a", "new call");
  throttle.push(end);
  throttle.push(start);
  throttle.push(fresh);
  advance(250);
  assert.deepEqual(sent, [end, start, fresh]);
});
