// Server half of web goal mode (see `lib/goal-web.ts`).
//
// omp-web drives an in-process AgentSession the way `omp --mode rpc` does, so
// the goal lifecycle is the SDK's own `RpcGoalController`: goal tool in the
// active tool set, completion/drop exit, journal reattach and automatic
// continuation. Only two things are web-specific and live here.
import { readFileSync } from "fs";
import { join } from "path";
import { getPackageDir } from "@oh-my-pi/pi-coding-agent/config";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { RpcGoalController, RPC_GOAL_CONTINUATION_MODE } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import { prompt } from "@oh-my-pi/pi-utils";
import { webGoalInfo, type WebGoalInfo } from "./goal-web";

type GoalControllerSession = ConstructorParameters<typeof RpcGoalController>[0];

/**
 * The SDK gates automatic goal continuation on `goal.continuationModes`, whose
 * default is `["interactive"]` — the TUI. The browser is an interactive client
 * too, so the controller sees `"rpc"` added whenever `"interactive"` is
 * configured. The overlay reads through to the live settings and is rebuilt
 * when they change, so editing the setting takes effect immediately.
 */
function webGoalSettings(getSettings: () => Settings): () => Settings {
  let cached: { parent: Settings; revision: number; view: Settings } | undefined;
  return () => {
    const parent = getSettings();
    const revision = parent.revision;
    if (cached?.parent === parent && cached.revision === revision) return cached.view;
    const modes = cfgGoalContinuationModes.get(parent);
    const view = modes.includes("interactive") && !modes.includes(RPC_GOAL_CONTINUATION_MODE)
      ? parent.overlay({ "goal.continuationModes": [...modes, RPC_GOAL_CONTINUATION_MODE] })
      : parent;
    cached = { parent, revision, view };
    return view;
  };
}

export function createWebGoalController(session: GoalControllerSession, onContinuationDropped?: () => void): RpcGoalController {
  const settings = webGoalSettings(() => session.settings);
  const view = new Proxy(session, {
    get(target, property) {
      if (property === "settings") return settings();
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new RpcGoalController(view, onContinuationDropped);
}

export function webGoalInfoForSession(session: Pick<GoalControllerSession, "settings" | "getGoalModeState">): WebGoalInfo {
  return webGoalInfo(session.getGoalModeState(), cfgGoalEnabled.get(session.settings));
}

export function isGoalModeAvailable(settings: Settings): boolean {
  return cfgGoalEnabled.get(settings);
}

/**
 * Kickoff for `/guided-goal`, rendered from the SDK's own template. The SDK
 * imports it as a text module, which the webpack externals cannot express, so
 * it is read from the installed package instead.
 */
export function renderGuidedGoalKickoff(initial: string | undefined): string {
  const packageDir = getPackageDir();
  if (!packageDir) throw new Error("Guided goal is unavailable: the omp package directory was not found.");
  const template = readFileSync(join(packageDir, "src", "prompts", "goals", "guided-goal-interview.md"), "utf8");
  return prompt.render(template, { initial: initial?.trim() || undefined });
}
