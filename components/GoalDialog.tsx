"use client";

import { useEffect, useRef, useState } from "react";
import type { GoalAction } from "@/hooks/useAgentSession";
import { useI18n } from "@/hooks/useI18n";
import { parseGoalBudget, type WebGoalInfo } from "@/lib/goal-web";
import { GoalStatusBar } from "./ChatInput";

export function GoalDialog({ info, busy, onClose, onCreate, onAction }: {
  info: WebGoalInfo | null;
  busy: boolean;
  onClose: () => void;
  onCreate: (objective: string, tokenBudget?: number) => Promise<void>;
  onAction: (action: GoalAction) => Promise<void>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goal = info?.goal;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("textarea, button")?.focus();
    return () => previous?.focus();
  }, []);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const tokenBudget = budget.trim() ? parseGoalBudget(budget) : null;
    if (tokenBudget === undefined) { setError(t("chat.goalBudgetInvalid")); return; }
    setSaving(true);
    setError(null);
    try { await onCreate(objective.trim(), tokenBudget ?? undefined); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const buttonStyle = { minHeight: 36, padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", cursor: "pointer" };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.4)" }} onMouseDown={(event) => { if (!saving && event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="goal-dialog-title" style={{ width: 520, maxWidth: "100%", maxHeight: "85dvh", overflowY: "auto", padding: 20, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 12px 36px rgba(0,0,0,0.24)" }} onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) { event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input');
        if (!elements?.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
        <h2 id="goal-dialog-title" style={{ margin: "0 0 16px", fontSize: 16 }}>{t(goal ? "chat.goalManage" : "chat.goalCreate")}</h2>
        {goal && info ? <>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 14, lineHeight: 1.6 }}>{goal.objective}</p>
          <GoalStatusBar info={info} onAction={saving ? undefined : (action) => { setSaving(true); void onAction(action).finally(() => setSaving(false)); }} t={t} />
          <div style={{ marginTop: 20, textAlign: "right" }}><button type="button" disabled={saving} style={buttonStyle} onClick={onClose}>{t("chat.goalClose")}</button></div>
        </> : <form onSubmit={create} style={{ display: "grid", gap: 14 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 13 }}>{t("chat.goalObjective")}
            <textarea required rows={4} value={objective} onChange={(event) => setObjective(event.target.value)} disabled={saving} style={{ padding: 10, resize: "vertical", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", font: "inherit" }} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 13 }}>{t("chat.goalOptionalBudget")}
            <input type="number" min="1" step="1" value={budget} onChange={(event) => setBudget(event.target.value)} disabled={saving} style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", font: "inherit" }} />
          </label>
          {error && <div role="alert" style={{ color: "var(--error)", fontSize: 13 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" style={buttonStyle} disabled={saving} onClick={onClose}>{t("chat.goalCancel")}</button>
            <button type="submit" disabled={busy || saving || !objective.trim()} style={{ ...buttonStyle, background: "var(--accent)", color: "var(--bg)", opacity: busy || saving || !objective.trim() ? 0.5 : 1 }}>{t("chat.goalCreate")}</button>
          </div>
        </form>}
      </div>
    </div>
  );
}
