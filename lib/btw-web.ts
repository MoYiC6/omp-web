import type { RpcBtwHistoryRecord } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

export type BtwRecord = RpcBtwHistoryRecord;
export type BtwTurn = Pick<BtwRecord, "question" | "answer" | "status" | "error" | "createdAt" | "updatedAt">;

export function latestBtwTurn(record: BtwRecord): BtwTurn {
  return record.followUps?.at(-1) ?? record;
}

/** SSE snapshots can beat the command response or a history read. Keep the newest turn. */
export function mergeBtwRecords(current: readonly BtwRecord[], incoming: readonly BtwRecord[]): BtwRecord[] {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) {
    const previous = records.get(record.id);
    const previousTurn = previous && latestBtwTurn(previous);
    const nextTurn = latestBtwTurn(record);
    if (previousTurn && (previousTurn.updatedAt > nextTurn.updatedAt
      || (previousTurn.updatedAt === nextTurn.updatedAt && previousTurn.status !== "running" && nextTurn.status === "running")
      || (previousTurn.updatedAt === nextTurn.updatedAt && previousTurn.status === "running" && nextTurn.status === "running" && previousTurn.answer.length > nextTurn.answer.length))) continue;
    records.set(record.id, record);
  }
  return [...records.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function appendBtwDelta(records: readonly BtwRecord[], recordId: string, delta: string): BtwRecord[] {
  return records.map((record) => {
    if (record.id !== recordId || latestBtwTurn(record).status !== "running") return record;
    const append = (turn: BtwTurn) => ({ ...turn, answer: turn.answer + delta });
    if (record.followUps?.length) {
      return { ...record, followUps: [...record.followUps.slice(0, -1), append(record.followUps.at(-1)!)] };
    }
    return { ...record, ...append(record) };
  });
}
