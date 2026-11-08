import type { CustomMessage, ToolResultMessage } from "./types";

export type SessionEvent = { type: string; [key: string]: unknown };
export type EventNotice = {
  type: "info" | "success" | "warning" | "error";
  key?: string;
  values?: Record<string, string | number>;
  message?: string;
};
export type SessionEventEffect = {
  thinkingLevel?: string;
  model?: { provider: string; modelId: string } | null;
  isCompacting?: boolean;
  notices?: EventNotice[];
  todos?: unknown[];
  ircMessage?: CustomMessage;
};

/** SDK invalidation events are enriched by the host; no network or React state here. */
export function sessionEventEffect(event: SessionEvent): SessionEventEffect | null {
  switch (event.type) {
    case "notice":
      return { notices: [{ type: event.level === "error" || event.level === "warning" ? event.level : "info", message: String(event.message ?? "") }] };
    case "thinking_level_changed":
      // Preserve the configured `auto` selector when the SDK resolves it for one turn.
      return { thinkingLevel: String(event.configured ?? event.thinkingLevel ?? "off") };
    case "model_changed":
      return { model: event.model as SessionEventEffect["model"] };
    case "manual_compaction_start":
    case "auto_compaction_start":
    case "compaction_start":
      return { isCompacting: true };
    case "manual_compaction_end":
    case "auto_compaction_end":
    case "compaction_end":
      return { isCompacting: false };
    case "retry_fallback_applied":
      return { notices: [{ type: "warning", key: "events.fallbackApplied", values: { from: String(event.from), to: String(event.to), reason: String(event.reason ?? "") } }] };
    case "retry_fallback_succeeded":
      // SDK confirms a successful fallback; it does not switch back to the original model.
      return { notices: [{ type: "success", key: "events.fallbackSucceeded", values: { model: String(event.model) } }] };
    case "ttsr_triggered":
      return { notices: [{ type: "info", key: "events.ttsr", values: { rules: (event.rules as { name?: string; path?: string }[] ?? []).map((rule) => rule.name ?? rule.path ?? "").filter(Boolean).join(", ") } }] };
    case "advisor_cost_changed":
      return { notices: typeof event.cost === "number" ? [{ type: "info", key: "events.advisorCost", values: { cost: event.cost.toFixed(4) } }] : [] };
    case "advisor_yielded":
      // Advice arrives as persisted custom messages; this marks the end of the review.
      return { notices: [{ type: "info", key: "events.advisorYielded" }] };
    case "irc_message":
      return { ircMessage: event.message as CustomMessage };
    case "todo_reminder":
      return { todos: event.todos as unknown[] ?? [], notices: [{ type: "warning", key: "events.todoReminder", values: { attempt: Number(event.attempt), maxAttempts: Number(event.maxAttempts) } }] };
    case "todo_auto_clear":
      return { todos: [], notices: [{ type: "info", key: "events.todoCleared" }] };
    case "config_warnings_changed":
      return { notices: (event.warnings as string[] ?? []).map((message) => ({ type: "warning", key: "events.configWarning", values: { message } })) };
    case "tool_stream_update":
    case "tool_execution_update":
      // The per-call reducer below owns streaming projections.
      return {};
    default:
      return null;
  }
}

/** Updates are snapshots, not deltas. Keep other calls and never mutate their frames. */
export function mergeToolStreamUpdate(current: ReadonlyMap<string, ToolResultMessage>, event: SessionEvent): ReadonlyMap<string, ToolResultMessage> {
  const id = event.toolCallId;
  if (typeof id !== "string") return current;
  if (event.type === "tool_execution_end") {
    if (!current.has(id)) return current;
    const next = new Map(current);
    next.delete(id);
    return next;
  }
  const update = (event.type === "tool_execution_update" ? event.partialResult : event.update) as Record<string, unknown> | undefined;
  if (!update || typeof update !== "object") return current;
  const files = Array.isArray(update.files) ? update.files as { path?: string; diff?: string; error?: string }[] : [];
  const content = Array.isArray(update.content) ? update.content as ToolResultMessage["content"]
    : [{ type: "text" as const, text: typeof update.text === "string" ? update.text : files.map((file) => [file.path, file.diff, file.error].filter(Boolean).join("\n")).join("\n\n") }];
  const next = new Map(current);
  next.set(id, { role: "toolResult", toolCallId: id, toolName: String(event.toolName ?? ""), content, details: update.details ?? (files.length ? { diff: files.map((file) => file.diff ?? "").join("\n") } : undefined), isPartial: true });
  return next;
}
