"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/api-path";
import type { InternalUrlContent } from "@/lib/internal-url-web";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "./MarkdownBody";

export function InternalUrlViewer({ url, sessionId, onOpenInternalUrl }: {
  url: string;
  sessionId: string;
  onOpenInternalUrl: (url: string) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<{ key: string; data?: InternalUrlContent; error?: boolean } | null>(null);
  const key = `${sessionId}:${url}`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(apiPath(`/api/sessions/${encodeURIComponent(sessionId)}/internal-url?url=${encodeURIComponent(url)}`), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Resource unavailable");
        const data = await response.json() as InternalUrlContent;
        if (!controller.signal.aborted) setState({ key, data });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ key, error: true }); });
    return () => controller.abort();
  }, [url, sessionId, key]);
  const current = state?.key === key ? state : null;
  return (
    <div style={{ height: "100%", overflow: "auto", padding: 20 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, overflowWrap: "anywhere" }}>{url}</div>
      {current?.error ? <div role="alert">{t("internalUrl.unavailable")}</div> : !current?.data ? t("i18n.loading") : current.data.contentType === "text/markdown" ? (
        <MarkdownBody onOpenInternalUrl={onOpenInternalUrl}>{current.data.content}</MarkdownBody>
      ) : (
        <pre style={{ fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13 }}>{current.data.content}</pre>
      )}
    </div>
  );
}
