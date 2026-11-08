import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mergeToolStreamUpdate, sessionEventEffect } from "./session-events";

describe("SDK session event projections", () => {
  test("notice preserves severity and payload", () => {
    for (const level of ["info", "warning", "error"] as const) {
      assert.deepEqual(sessionEventEffect({ type: "notice", level, message: "payload" })?.notices, [{ type: level, message: "payload" }]);
    }
  });
  test("thinking sync preserves configured auto and handles off", () => {
    assert.equal(sessionEventEffect({ type: "thinking_level_changed", thinkingLevel: "high", configured: "auto", resolved: "high" })?.thinkingLevel, "auto");
    assert.equal(sessionEventEffect({ type: "thinking_level_changed", thinkingLevel: "low" })?.thinkingLevel, "low");
    assert.equal(sessionEventEffect({ type: "thinking_level_changed" })?.thinkingLevel, "off");
  });
  test("model invalidation synchronizes the host snapshot including no model", () => {
    const model = { provider: "test", modelId: "other" };
    assert.deepEqual(sessionEventEffect({ type: "model_changed", model })?.model, model);
    assert.equal(sessionEventEffect({ type: "model_changed", model: null })?.model, null);
  });
  for (const prefix of ["manual_compaction", "auto_compaction", "compaction"]) {
    test(`${prefix} synchronizes busy state`, () => {
      assert.equal(sessionEventEffect({ type: `${prefix}_start` })?.isCompacting, true);
      assert.equal(sessionEventEffect({ type: `${prefix}_end`, aborted: true })?.isCompacting, false);
      assert.equal(sessionEventEffect({ type: `${prefix}_end`, errorMessage: "failed" })?.isCompacting, false);
    });
  }
  test("fallback applied and success have distinct severity without inventing restoration", () => {
    const applied = sessionEventEffect({ type: "retry_fallback_applied", from: "a", to: "b", reason: "limit" });
    assert.equal(applied?.notices?.[0].type, "warning");
    assert.deepEqual(applied?.notices?.[0].values, { from: "a", to: "b", reason: "limit" });
    const succeeded = sessionEventEffect({ type: "retry_fallback_succeeded", model: "b" });
    assert.equal(succeeded?.notices?.[0].type, "success");
    assert.equal(succeeded?.model, undefined);
  });
  test("TTSR includes matched rule names", () => {
    assert.equal(sessionEventEffect({ type: "ttsr_triggered", rules: [{ name: "security" }, { name: "style" }] })?.notices?.[0].values?.rules, "security, style");
  });
  test("advisor cost and yield surface display effects", () => {
    assert.equal(sessionEventEffect({ type: "advisor_cost_changed", cost: 1.25 })?.notices?.[0].values?.cost, "1.2500");
    assert.equal(sessionEventEffect({ type: "advisor_yielded" })?.notices?.[0].type, "info");
  });
  test("IRC preserves the custom message content", () => {
    const message = { role: "custom", customType: "irc", display: true, content: "review ready" };
    assert.deepEqual(sessionEventEffect({ type: "irc_message", message })?.ircMessage, message);
  });
  test("todo reminder and clear synchronize the active checklist", () => {
    const todos = [{ content: "finish", status: "in_progress" }];
    assert.deepEqual(sessionEventEffect({ type: "todo_reminder", todos, attempt: 1, maxAttempts: 3 })?.todos, todos);
    assert.deepEqual(sessionEventEffect({ type: "todo_auto_clear" })?.todos, []);
  });
  test("configuration warnings preserve all warning details", () => {
    assert.deepEqual(sessionEventEffect({ type: "config_warnings_changed", warnings: ["a", "b"] })?.notices?.map((notice) => [notice.type, notice.values?.message]), [["warning", "a"], ["warning", "b"]]);
    assert.deepEqual(sessionEventEffect({ type: "config_warnings_changed", warnings: [] })?.notices, []);
  });
  test("stream events are explicitly owned and unknown events remain unhandled", () => {
    assert.deepEqual(sessionEventEffect({ type: "tool_stream_update" }), {});
    assert.deepEqual(sessionEventEffect({ type: "tool_execution_update" }), {});
    assert.equal(sessionEventEffect({ type: "future_event" }), null);
  });
});

describe("tool stream snapshots", () => {
  test("merges by toolCallId, replaces snapshots and preserves concurrent calls immutably", () => {
    const empty = new Map();
    const first = mergeToolStreamUpdate(empty, { type: "tool_stream_update", toolCallId: "a", toolName: "edit", update: { files: [{ path: "a.ts", diff: "+first" }] } });
    const concurrent = mergeToolStreamUpdate(first, { type: "tool_execution_update", toolCallId: "b", toolName: "bash", partialResult: { content: [{ type: "text", text: "working" }] } });
    const next = mergeToolStreamUpdate(concurrent, { type: "tool_stream_update", toolCallId: "a", toolName: "edit", update: { files: [{ path: "a.ts", diff: "+second" }] } });
    assert.equal(empty.size, 0);
    assert.equal(next.size, 2);
    assert.equal(next.get("b"), concurrent.get("b"));
    assert.equal(next.get("a")?.isPartial, true);
    assert.match(JSON.stringify(next.get("a")?.content), /second/);
    assert.doesNotMatch(JSON.stringify(next.get("a")?.content), /first/);
    assert.match(JSON.stringify(first.get("a")?.content), /first/);
    const done = mergeToolStreamUpdate(next, { type: "tool_execution_end", toolCallId: "a" });
    assert.equal(done.has("a"), false);
    assert.equal(done.get("b"), next.get("b"));
  });
  test("ignores missing payloads and identities", () => {
    const current = new Map();
    assert.equal(mergeToolStreamUpdate(current, { type: "tool_stream_update", toolCallId: "a" }), current);
    assert.equal(mergeToolStreamUpdate(current, { type: "tool_stream_update", update: {} }), current);
  });
});
