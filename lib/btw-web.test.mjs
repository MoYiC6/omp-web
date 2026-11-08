import assert from "node:assert/strict";
import test from "node:test";
import { AgentSessionWrapper } from "./rpc-manager.ts";
import { appendBtwDelta, latestBtwTurn, mergeBtwRecords } from "./btw-web.ts";

const record = { id: "topic", leafId: null, question: "1+1=?", answer: "", status: "running", createdAt: 1, updatedAt: 1 };

test("btw command snapshots cannot replace streamed text or resurrect a completed turn", () => {
  const partial = appendBtwDelta([record], record.id, "2");
  assert.equal(mergeBtwRecords(partial, [record])[0].answer, "2");
  const complete = { ...record, answer: "2", status: "complete", updatedAt: 2 };
  assert.deepEqual(mergeBtwRecords([complete], [record]), [complete]);
  assert.equal(appendBtwDelta([complete], record.id, "late")[0].answer, "2");
});

test("btw follow-up deltas update only the latest turn", () => {
  const topic = { ...record, answer: "2", status: "complete", followUps: [{ ...record, question: "Plus one?", answer: "", createdAt: 2, updatedAt: 2 }] };
  const updated = appendBtwDelta([topic], record.id, "3")[0];
  assert.equal(updated.answer, "2");
  assert.equal(latestBtwTurn(updated).answer, "3");
  assert.equal(latestBtwTurn(topic).answer, "");
});

function makeWrapper(runEphemeralTurn) {
  const inner = {
    model: { id: "test", provider: "test", api: "openai-completions" },
    sessionManager: { getSessionId: () => "btw-test", getArtifactsDir: () => undefined, getLeafId: () => null, ensureOnDisk: async () => {} },
    runEphemeralTurn,
    dispose: async () => {},
  };
  return new AgentSessionWrapper(inner, { on: () => () => {} });
}

function terminalFrame(wrapper) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No terminal btw frame")), 2000);
    const unsubscribe = wrapper.onEvent((event) => {
      if (event.type === "btw_record" && latestBtwTurn(event.record).status !== "running") {
        clearTimeout(timer);
        unsubscribe();
        resolve(event.record);
      }
    });
  });
}

test("wrapper uses the SDK side channel, streams answers and continues the same topic", async () => {
  const calls = [];
  const wrapper = makeWrapper(async (options) => {
    calls.push(options);
    options.onTextDelta(calls.length === 1 ? "2" : "3");
    return { replyText: calls.length === 1 ? "2" : "3" };
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  try {
    let terminal = terminalFrame(wrapper);
    const { record } = await wrapper.send({ type: "btw", question: "1+1=?" });
    assert.equal(record.status, "running");
    assert.equal((await terminal).answer, "2");
    terminal = terminalFrame(wrapper);
    await wrapper.send({ type: "btw", question: "Plus one?", recordId: record.id });
    assert.equal(latestBtwTurn(await terminal).answer, "3");
    assert.equal(calls[1].history.length, 2);
    assert.equal((await wrapper.send({ type: "get_btw_history" })).records.length, 1);
    assert.ok(events.some((event) => event.type === "btw_delta"));
    assert.ok(events.every((event) => !event.type.startsWith("message_")));
  } finally { await wrapper.destroy(); }
});

test("wrapper cancellation and destruction checkpoint running side questions", async () => {
  const wrapper = makeWrapper(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
  try {
    const { record } = await wrapper.send({ type: "btw", question: "Wait" });
    assert.equal((await wrapper.send({ type: "btw_cancel", recordId: "another" })).cancelled, false);
    assert.equal((await wrapper.send({ type: "btw_cancel", recordId: record.id })).cancelled, true);
    assert.equal((await wrapper.send({ type: "get_btw_history" })).records[0].status, "cancelled");
    const terminal = terminalFrame(wrapper);
    await wrapper.send({ type: "btw", question: "Wait again" });
    await wrapper.destroy();
    assert.equal((await terminal).status, "cancelled");
    assert.equal(wrapper.isAlive(), false);
  } finally { await wrapper.destroy(); }
});
