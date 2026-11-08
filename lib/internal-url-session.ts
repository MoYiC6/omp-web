import { getAgentDir, loadSkills, SessionManager, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import type { ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { cfgSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { getRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { getSettingsForCwd } from "./omp-runtime";
import { isReadableInternalUrl, type InternalUrlContent } from "./internal-url-web";

export async function readSessionInternalUrl(id: string, url: string, signal?: AbortSignal): Promise<InternalUrlContent | null> {
  if (!isReadableInternalUrl(url)) throw new Error("Unsupported internal URL");
  const wrapper = getRpcSession(id);
  const live = wrapper?.isAlive() ? wrapper.inner as unknown as AgentSession : undefined;
  const file = live?.sessionFile ?? await resolveSessionPath(id);
  if (!live && !file) return null;
  const manager = live?.sessionManager ?? await SessionManager.open(file!);
  const cwd = manager.getCwd();
  const settings = live?.settings ?? await getSettingsForCwd(cwd);
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  const skills = scheme === "skill"
    ? live?.skills ?? (await loadSkills({ cwd, ...cfgSkills.get(settings) })).skills
    : [];
  const rules = scheme === "rule"
    ? (await loadCapability<Rule>(ruleCapability.id, { cwd, agentDir: getAgentDir() })).items
    : [];
  // A private roster prevents a same-named agent in a different web conversation
  // from answering this request. Restore parked children without starting an agent.
  const artifactsDir = manager.getArtifactsDir();
  if ((scheme === "agent" || scheme === "artifact") && !artifactsDir) {
    throw new Error("Session artifacts unavailable");
  }
  const registry = new AgentRegistry();
  if (scheme === "agent" && file) await ensurePersistedRoster(registry, file);
  for (const ref of AgentRegistry.global().list()) {
    const refFile = ref.session?.sessionFile ?? ref.sessionFile;
    if (refFile && (refFile === file || (artifactsDir && refFile.startsWith(`${artifactsDir}/`)))) {
      registry.register({ ...ref });
    }
  }
  const toolSession = {
    cwd, settings, skills, activeRules: rules, agentRegistry: registry,
    sessionManager: manager,
    getSessionFile: () => manager.getSessionFile(),
    getSessionId: () => manager.getSessionId(),
    getArtifactsDir: () => artifactsDir,
    localProtocolOptions: {
      getArtifactsDir: () => artifactsDir,
      getSessionId: () => manager.getSessionId(),
    },
    // SDK agent/artifact handlers otherwise sweep process-global directories.
    // Their consultation scope pins reads exclusively to this conversation.
    seanceSourceArtifactsDir: artifactsDir,
  } as unknown as ToolSession;
  const context: ResolveContext = sessionResolveContext(toolSession, { signal, containSkillPaths: true });
  if (scheme === "memory" && !live) {
    // SDK file-backed memory only needs cwd and settings. The private registry
    // prevents its cwd fallback from binding a different web conversation.
    delete context.sessionFile;
    delete context.sessionId;
  }
  const router = InternalUrlRouter.instance();
  if (scheme === "skill") {
    // Unknown skill:// names may fall back to MCP in the SDK. Browser reads
    // deliberately accept only loaded local skills and contained paths.
    const path = await router.locate(url, context);
    if (!path) throw new Error("Skill not found");
  }
  const resource = await router.resolve(url, context);
  return { url, content: resource.content, contentType: resource.contentType };
}
