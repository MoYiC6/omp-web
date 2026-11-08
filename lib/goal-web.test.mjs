import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldNotifyGoalCompletion } from "./goal-web.ts";

const info = (status, id = "goal-1") => ({ available: true, enabled: status === "active", goal: { id, objective: "Finish the task", status, tokensUsed: 42, timeUsedSeconds: 2 } });
const cleared = { available: true, enabled: false, goal: null };

test("goal completion notifies when the SDK reports complete or clears a completed goal", () => {
  assert.equal(shouldNotifyGoalCompletion(info("active"), info("complete")), true);
  assert.equal(shouldNotifyGoalCompletion(info("complete"), cleared), true);
  assert.equal(shouldNotifyGoalCompletion(info("paused"), info("complete")), true);
});

test("dropping or clearing without completion evidence does not notify", () => {
  assert.equal(shouldNotifyGoalCompletion(info("active"), info("dropped")), false);
  assert.equal(shouldNotifyGoalCompletion(info("dropped"), cleared), false);
  assert.equal(shouldNotifyGoalCompletion(info("active"), cleared), false);
  assert.equal(shouldNotifyGoalCompletion(cleared, cleared), false);
});

test("unchanged goals, initial loads, and replacement goals do not notify", () => {
  for (const status of ["active", "paused", "budget-limited", "complete", "dropped"]) {
    assert.equal(shouldNotifyGoalCompletion(info(status), info(status)), false);
  }
  assert.equal(shouldNotifyGoalCompletion(null, info("complete")), false);
  assert.equal(shouldNotifyGoalCompletion(info("complete"), info("active", "goal-2")), false);
});
