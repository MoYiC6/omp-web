export interface WebLoopInfo {
  enabled: boolean;
  status: "waiting" | "running" | "paused";
  prompt?: string;
  iterations: number;
  limit?: { kind: "iterations"; initial: number; remaining: number } | { kind: "duration"; durationMs: number; deadlineMs: number };
  condition?: { command: string; until: boolean };
  reason?: string;
}
