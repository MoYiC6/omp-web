"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { latestBtwTurn, type BtwRecord } from "@/lib/btw-web";
import { MarkdownBody } from "./MarkdownBody";

export function BtwPanel({ records, onAsk, onCancel }: {
  records: readonly BtwRecord[];
  onAsk: (question: string, recordId: string) => Promise<void>;
  onCancel: (recordId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const running = records.some((record) => latestBtwTurn(record).status === "running");
  return (
    <aside aria-label={t("btw.title")} className="my-4 min-w-0 rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-4">
      <h2 className="text-sm font-semibold text-[var(--text)]">{t("btw.title")}</h2>
      <p className="mb-4 mt-1 text-xs text-[var(--text-muted)]">{t("btw.description")}</p>
      {records.length === 0 && <p className="text-sm text-[var(--text-muted)]">{t("btw.empty")}</p>}
      <div className="space-y-4">
        {records.map((record) => <BtwCard key={record.id} record={record} running={running} onAsk={onAsk} onCancel={onCancel} />)}
      </div>
    </aside>
  );
}

function BtwCard({ record, running, onAsk, onCancel }: {
  record: BtwRecord;
  running: boolean;
  onAsk: (question: string, recordId: string) => Promise<void>;
  onCancel: (recordId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = latestBtwTurn(record);
  const status = {
    running: t("btw.running"), complete: t("btw.complete"), cancelled: t("btw.cancelled"),
    error: t("btw.error"), interrupted: t("btw.interrupted"),
  }[latest.status];
  const turns = [record, ...(record.followUps ?? [])];
  const act = async (operation: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };
  return (
    <section className="min-w-0 rounded-lg border border-[var(--border)] p-3" data-btw-record={record.id}>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
        <span role="status">{status}</span>
        {latest.status === "running" && <button type="button" disabled={pending} onClick={() => void act(() => onCancel(record.id))} className="min-h-11 rounded px-3 hover:bg-[var(--bg-hover)] disabled:opacity-50">{t("btw.cancel")}</button>}
      </div>
      {turns.map((turn, index) => (
        <div key={index} className="mb-3 min-w-0 break-words">
          <p className="mb-2 whitespace-pre-wrap text-sm font-medium text-[var(--text)]">{turn.question}</p>
          {turn.answer && <MarkdownBody>{turn.answer}</MarkdownBody>}
          {turn.error && <p role="alert" className="mt-2 text-sm text-[var(--error)]">{turn.error}</p>}
        </div>
      ))}
      <form onSubmit={(event) => {
        event.preventDefault();
        const trimmed = question.trim();
        if (!trimmed || running || pending) return;
        void act(async () => { await onAsk(trimmed, record.id); setQuestion(""); });
      }} className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-[var(--text-muted)]">
          {t("btw.followUp")}
          <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={t("btw.followUpPlaceholder")} className="mt-1 min-h-11 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)]" />
        </label>
        <button type="submit" disabled={running || pending || !question.trim()} className="min-h-11 rounded-md border border-[var(--border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-50">{t("btw.ask")}</button>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-[var(--error)]">{error}</p>}
    </section>
  );
}
