/** Read-only browser surface. Never pass an unlisted scheme to the SDK router. */
export const READABLE_INTERNAL_SCHEMES: Record<string, true> = {
  agent: true, artifact: true, local: true, memory: true, issue: true,
  pr: true, skill: true, rule: true, omp: true,
};

export function isReadableInternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  return !!match && Object.hasOwn(READABLE_INTERNAL_SCHEMES, match[1].toLowerCase());
}

export interface InternalUrlContent {
  url: string;
  content: string;
  contentType: "text/markdown" | "application/json" | "text/plain";
}
