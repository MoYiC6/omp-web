// Web goal mode: parity with the TUI `/goal` and `/guided-goal` commands.
//
// The SDK ships both commands TUI-only (`builtin-modes.ts` has only
// `handleTui`), so the ACP dispatcher behind `execute_slash_command` leaves
// them unhandled. The goal lifecycle itself (create/resume/pause/drop,
// accounting, tool set, continuation) is the SDK's `RpcGoalController`, wired
// in `lib/rpc-manager.ts`. This module stays dependency-free so the React hook
// can share the `/goal` argument parser and the journal reader.

export type WebGoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface WebGoal {
  id: string;
  objective: string;
  status: WebGoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
}

/**
 * Observable goal state returned by `get_state`, the `goal` command and the
 * session-detail endpoint. `goal` is null when the session has none;
 * `enabled` is false while the goal is paused. `available` mirrors the
 * `goal.enabled` setting.
 */
export interface WebGoalInfo {
  available: boolean;
  enabled: boolean;
  goal: WebGoal | null;
}

/** Completion is explicit in the SDK; a missing goal alone can also mean drop. */
export function shouldNotifyGoalCompletion(previous: WebGoalInfo | null, next: WebGoalInfo | null): boolean {
  const before = previous?.goal;
  const after = next?.goal;
  if (!before || before.status === "dropped") return false;
  if (after && after.id !== before.id) return false;
  return before.status === "complete"
    ? !after
    : after?.status === "complete";
}

/** Ops accepted by the wrapper's `goal` command. */
export type WebGoalOp = "get" | "create" | "set" | "pause" | "resume" | "drop" | "budget" | "guided";

/** Parsed `/goal` arguments, mirroring the TUI's subcommand set. */
export type GoalSlashCommand =
  | { kind: "menu" }
  | { kind: "create"; objective: string }
  | { kind: "set"; objective: string }
  | { kind: "show" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "drop" }
  | { kind: "budget"; tokenBudget: number | null }
  | { kind: "invalid"; error: string };

const GOAL_SUBCOMMANDS: Record<string, true> = { set: true, show: true, pause: true, resume: true, drop: true, budget: true };

/**
 * `/goal` with no arguments opens the goal menu; a first word naming a
 * subcommand selects it; any other text is the objective of a new goal.
 */
export function parseGoalSlashCommand(args: string): GoalSlashCommand {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "menu" };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const first = match?.[1]?.toLowerCase() ?? "";
  if (GOAL_SUBCOMMANDS[first] !== true) return { kind: "create", objective: trimmed };
  const rest = match?.[2]?.trim() ?? "";
  switch (first) {
    case "set":
      return rest ? { kind: "set", objective: rest } : { kind: "invalid", error: "Usage: /goal set <objective>" };
    case "budget": {
      if (!rest) return { kind: "invalid", error: "Usage: /goal budget <N|off>" };
      const tokenBudget = parseGoalBudget(rest);
      return tokenBudget === undefined
        ? { kind: "invalid", error: "Goal budget must be a positive integer or `off`." }
        : { kind: "budget", tokenBudget };
    }
    case "show":
      return { kind: "show" };
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    default:
      return { kind: "drop" };
  }
}

/** `off` clears the budget (null); a positive integer sets it; anything else is invalid (undefined). */
export function parseGoalBudget(raw: string): number | null | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "off") return null;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Rebuild a goal from a `mode_change` payload; null when malformed (session files are user-editable). */
export function readWebGoal(value: unknown): WebGoal | null {
  if (!value || typeof value !== "object") return null;
  const goal = value as Record<string, unknown>;
  if (
    typeof goal.id !== "string"
    || typeof goal.objective !== "string"
    || typeof goal.status !== "string"
    || typeof goal.tokensUsed !== "number"
    || typeof goal.timeUsedSeconds !== "number"
  ) {
    return null;
  }
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status as WebGoalStatus,
    ...(typeof goal.tokenBudget === "number" ? { tokenBudget: goal.tokenBudget } : {}),
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
  };
}

/** Shape a live `GoalModeState` (or the `goal_updated` event payload) for the browser. */
export function webGoalInfo(
  state: { enabled: boolean; goal: unknown } | null | undefined,
  available: boolean,
): WebGoalInfo {
  const goal = readWebGoal(state?.goal);
  if (!state || !goal || goal.status === "dropped") return { available, enabled: false, goal: null };
  return { available, enabled: state.enabled, goal };
}

type ModeChangeEntryLike = { type?: string; mode?: string; data?: Record<string, unknown> };

/**
 * Goal state for a session with no live wrapper: the last `mode_change` entry
 * wins, the same journal contract the TUI and `RpcGoalController.reconcile`
 * read (`goal` = active, `goal_paused` = paused).
 */
export function goalInfoFromEntries(entries: readonly ModeChangeEntryLike[]): WebGoalInfo {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "mode_change") continue;
    if (entry.mode !== "goal" && entry.mode !== "goal_paused") break;
    return webGoalInfo({ enabled: entry.mode === "goal", goal: entry.data?.goal }, true);
  }
  return { available: true, enabled: false, goal: null };
}

/** Multi-line goal summary for `/goal show` (the TUI's `#showGoalDetails`). */
export function formatGoalDetails(info: WebGoalInfo): string {
  const goal = info.goal;
  if (!goal) return "No goal set.";
  const used = goal.tokensUsed.toLocaleString();
  const tokens = goal.tokenBudget !== undefined
    ? `${used} / ${goal.tokenBudget.toLocaleString()} (${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} left)`
    : `${used} (no budget)`;
  return [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}${info.enabled || goal.status === "paused" ? "" : " (paused)"}`,
    `Tokens: ${tokens}`,
    `Time spent: ${formatGoalDuration(goal.timeUsedSeconds)}`,
  ].join("\n");
}

export function formatGoalDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
