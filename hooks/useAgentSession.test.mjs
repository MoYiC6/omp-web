import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

test("keeps the session event stream open through the idle grace window", () => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  const agentStartSource = source.slice(
    source.indexOf('case "agent_start"'),
    source.indexOf('case "agent_end"'),
  );
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(source, /const EVENT_STREAM_IDLE_GRACE_MS = 30_000/);
  assert.match(graceSource, /setTimeout\(\(\) => void checkServerIdle\(\), EVENT_STREAM_IDLE_GRACE_MS\)/);
  assert.match(graceSource, /fetch\(apiPath\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}`\)\)/);
  assert.match(graceSource, /closeEvents\(\)/);
  assert.match(finishSource, /scheduleEventStreamClose\(sid\)/);
  assert.doesNotMatch(finishSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.match(agentStartSource, /cancelEventStreamGrace\(\)/);
  assert.match(agentSettledSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(agentSettledSource, /onAgentEnd\?\.\(\)/);
  assert.match(promptDoneSource, /notifyPromptStage\(runId\)/);
  assert.match(promptDoneSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(sendSource, /const definitivelyRejected = !promptRequestStarted \|\| isPromptRejectedError\(e\)/);
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{[\s\S]*?waitForPromptSettlement/);
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?closeEvents\(\)/);
});

test("reuses an open event stream and hides an empty agent phase", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureEventsConnected"),
    source.indexOf("const respondToExtensionUi"),
  );

  assert.match(ensureSource, /eventSourceSessionIdRef\.current === sid/);
  assert.match(ensureSource, /current\.readyState === EventSource\.OPEN/);
  assert.match(ensureSource, /attempt\?\.source === current && attempt\.pending/);
  assert.match(chatWindowSource, /agentRunning && !streamState\.streamingMessage && agentPhase/);
  assert.match(chatWindowSource, /return null;/);
});

test("plays the enabled sound once for each extension dialog", () => {
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef = useRef<string \| null>\(null\)/);
  assert.match(
    chatWindowSource,
    /soundedExtensionDialogIdRef\.current === extensionDialog\.id/,
  );
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef\.current = extensionDialog\.id/);
  assert.match(chatWindowSource, /playDoneSoundRef\.current\(\)/);
});

test("keeps completed subagents in the session history", () => {
  assert.match(source, /function mergeSubagentSnapshots/);
  assert.match(source, /const finished: SubagentSnapshot/);
  assert.match(source, /progress: previous\?\.progress \? \{ \.\.\.previous\.progress, status: terminalStatus \}/);
  assert.doesNotMatch(source, /payload\.status !== "started"\) \{\s*setSubagents\(\(previous\) => previous\.filter/);
});

test("routes blocking extension requests through deduplicated browser attention notifications", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(
    extensionRequestSource,
    /isBlockingExtensionUiRequest\(request\)[\s\S]*?onAttentionNeeded\?\.\(request\)/,
  );
  assert.match(chatWindowSource, /onAttentionNeeded, onSessionCreated/);
  assert.match(completionSource, /if \(!shouldShowBrowserNotification\(\)\) return/);
  assert.match(attentionSource, /shouldShowBrowserNotification\(\)/);
  assert.match(attentionSource, /claimExtensionAttentionNotification\(request, notifiedAttentionRequestIdsRef\.current\)/);
  assert.match(attentionSource, /tag: `pi-extension-ui:\$\{request\.id\}`/);
  assert.match(appShellSource, /onAttentionNeeded=\{handleAttentionNeeded\}/);
});

test("failed sends restore the submission into the composer and surface the server reason (#83)", () => {
  const ensureSource = source.slice(
    source.indexOf("  const ensureNewSession = useCallback"),
    source.indexOf("  const uploadSessionFiles = useCallback"),
  );
  const restoreSource = source.slice(
    source.indexOf("  const restoreFailedSubmission = useCallback"),
    source.indexOf("  const handleSend = useCallback"),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );
  const queuedSource = source.slice(
    source.indexOf("  const handleSteer = useCallback"),
    source.indexOf("  const handleAbortCompaction = useCallback"),
  );

  // ensureNewSession must read the response body even on failure so the
  // server's own reason (e.g. "database disk image is malformed") reaches
  // the notice instead of an opaque "HTTP 500".
  assert.match(ensureSource, /res\.json\(\)\.catch\(\(\) => null\)/);
  assert.match(ensureSource, /if \(!res\.ok \|\| !result\?\.sessionId\)/);
  assert.match(ensureSource, /throw new Error\(apiErrorMessage\(res\.status, result\)\)/);

  // The shared failure path keeps both halves of the contract: the error is
  // still noticed and the text/images go back through restoreSubmission,
  // which re-persists the draft and merges with anything typed since.
  assert.match(restoreSource, /addNotice\(\{ type: "error", message: e instanceof Error \? e\.message : String\(e\) \}\)/);
  assert.match(restoreSource, /restoreSubmission\?\.\(/);

  // A definitively rejected prompt restores into the draft the text was taken
  // from (ChatInput hands its key to the send callbacks). For a first send that
  // is still the provisional `new:<cwd>` key — the freshly created session id
  // only becomes the composer's key after promotion, so it is never the target (#88).
  assert.match(sendSource, /const handleSend = useCallback\(async \(message: string, images\?: AttachedImage\[\], draftKey\?: string\)/);
  assert.match(sendSource, /restoreFailedSubmission\(\s*"Failed to send message:",\s*e,\s*message,\s*images,[\s\S]*?\bdraftKey,\s*\);/);
  assert.doesNotMatch(sendSource, /sentSessionId \?\? undefined/);
  assert.doesNotMatch(sendSource, /session\?\.id \?\? sentSessionId/);

  // Every queued send path funnels failures through the same restore — a
  // failed steer/follow-up used to eat the text with only a console.error —
  // and restores into the draft it came from, not whatever session id the hook holds.
  assert.match(queuedSource, /restoreFailedSubmission\("Failed to steer:", e, message, images, draftKey\);/);
  assert.match(queuedSource, /restoreFailedSubmission\("Failed to queue prompt:", e, message, images, draftKey\);/);
  assert.match(queuedSource, /restoreFailedSubmission\("Failed to follow up:", e, message, images, draftKey\);/);
  assert.doesNotMatch(queuedSource, /images, sid\)/);
});

// Known limit (deferred, #70): these tests assert the hook's wiring on its
// source text, like the rest of this file. The decisions behind it (which
// submission an id confirms, takes or leaves pending) run for real in
// lib/draft-store.test.mjs; the hook itself has no render harness here.
test("every prompt carries a promptId and only its own events settle its draft (#88)", () => {
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );
  const promptErrorSource = source.slice(
    source.indexOf('case "prompt_error"'),
    source.indexOf('case "mode_change"'),
  );
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const confirmSource = source.slice(
    source.indexOf("  const confirmPrompt = useCallback"),
    source.indexOf("  const restoreRejectedPrompt = useCallback"),
  );
  const restoreSource = source.slice(
    source.indexOf("  const restoreRejectedPrompt = useCallback"),
    source.indexOf("  const scheduleEventStreamClose = useCallback"),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );
  const abortSource = source.slice(
    source.indexOf("  const handleAbort = useCallback"),
    source.indexOf("  const handleFork = useCallback"),
  );
  const steerSource = source.slice(
    source.indexOf("  const handleSteer = useCallback"),
    source.indexOf("  const handlePromptWithStreamingBehavior = useCallback"),
  );
  const behaviorSource = source.slice(
    source.indexOf("  const handlePromptWithStreamingBehavior = useCallback"),
    source.indexOf("  const handleFollowUp = useCallback"),
  );
  const followUpSource = source.slice(
    source.indexOf("  const handleFollowUp = useCallback"),
    source.indexOf("  const handleAbortCompaction = useCallback"),
  );
  const confirmQueuedSource = source.slice(
    source.indexOf("function confirmQueuedDraft"),
    source.indexOf("function delay"),
  );

  // The hook reaches a draft only through the tracker, plus the one direct
  // confirm a queued steer / follow-up needs (below). The global flags that
  // let one prompt's error or abort decide another prompt's fate are gone.
  assert.match(source, /import \{ confirmDraft, createSubmissionTracker \} from "@\/lib\/draft-store";/);
  assert.match(source, /const \[submissions\] = useState\(createSubmissionTracker\);/);
  assert.doesNotMatch(source, /clearDraft|setDraft\(/);
  assert.equal(source.match(/confirmDraft\(/g)?.length, 2, "only confirmQueuedDraft confirms directly");
  assert.doesNotMatch(source, /promptErroredRef|promptAbortedRef|settleSubmittedDrafts|restoreInFlightPrompt|keepOnRecord/);

  // Every dispatched prompt carries a client-generated id, unique across tabs
  // (SSE is shared by every tab of a session, so a bare counter would collide),
  // and is tracked under it.
  assert.match(source, /function createClientId\(\): string \{[\s\S]*?crypto\.randomUUID\(\)[\s\S]*?Math\.random\(\)/);
  assert.match(sendSource, /const promptId = createClientId\(\);/);
  assert.match(sendSource, /const submission = submissions\.track\(draftKey, message, promptId\);/);
  assert.match(sendSource, /inFlightPromptRef\.current = \{ promptId, message, images \};/);
  assert.equal(sendSource.match(/type: "prompt",\s*promptId,\s*message,/g)?.length, 2, "first send and existing-session send");
  assert.match(behaviorSource, /const promptId = createClientId\(\);\s*const submission = submissions\.track\(draftKey, message, promptId\);/);
  assert.match(behaviorSource, /type: "prompt",\s*promptId,\s*message,\s*streamingBehavior: behavior,/);
  assert.match(source, /inFlightPromptRef = useRef<\{ promptId: string; message: string; images\?: AttachedImage\[\] \} \| null>\(null\);/);

  // prompt_done confirms the submission of its own id. A queued prompt's
  // prompt_done (streamingBehavior set) settles only that submission and is
  // handled before anything touches the main turn's UI stage.
  assert.match(promptDoneSource, /if \(typeof event\.streamingBehavior === "string"\) \{\s*confirmPrompt\(event\);\s*break;\s*\}/);
  assert.ok(
    promptDoneSource.indexOf("streamingBehavior") < promptDoneSource.indexOf("rpcPromptPendingRef.current = false"),
    "the queued-prompt branch runs before the main UI settle",
  );
  // A prompt_done that arrives after the poll fallback settled the UI still confirms its prompt.
  assert.match(promptDoneSource, /confirmPrompt\(event\);\s*const firstNotification = notifyPromptStage\(runId\);\s*if \(!promptWasPending && !firstNotification\) break;/);
  assert.match(confirmSource, /const promptId = typeof event\.promptId === "string" \? event\.promptId : undefined;/);
  assert.match(confirmSource, /if \(promptId && inFlightPromptRef\.current\?\.promptId === promptId\) inFlightPromptRef\.current = null;/);
  // The tracker is told the id (or its absence, for an older remote), never "everything".
  assert.match(confirmSource, /submissions\.confirm\(sessionIdRef\.current, promptId\);/);
  // agent_settled only settles the UI: it carries no prompt identity.
  assert.match(agentSettledSource, /settleUiStage\(\)/);
  assert.doesNotMatch(agentSettledSource, /confirmPrompt|submissions\./);

  // prompt_error still notices the failure, then restores only the prompt it names.
  assert.match(promptErrorSource, /addNotice\(\{ type: "error"[^\n]*\);\s*restoreRejectedPrompt\(event\);/);
  assert.match(restoreSource, /const promptId = typeof event\.promptId === "string" \? event\.promptId : undefined;/);
  // A queued prompt gives back its own tracked text and never the main prompt.
  assert.match(restoreSource, /if \(typeof event\.streamingBehavior === "string"\) \{\s*const submission = submissions\.takeById\(promptId\);\s*if \(submission\) prompt = \{ message: submission\.text \};\s*\}/);
  // The main prompt is restored (text and images) only when the id is this hook's
  // in-flight prompt; it leaves the tracker in the same step, so the prompt_done
  // that follows a failed turn confirms nothing.
  assert.match(restoreSource, /\} else if \(promptId && inFlightPromptRef\.current\?\.promptId === promptId\) \{\s*prompt = inFlightPromptRef\.current;\s*inFlightPromptRef\.current = null;\s*submissions\.takeById\(promptId\);\s*\}/);
  // No target draft key: ChatInput restores into the composer on screen, which is
  // `new:<cwd>` before promotion and the session id after it.
  assert.match(restoreSource, /restoreSubmission\?\.\(\s*prompt\.message,\s*prompt\.images\?\.map\(\(\{ data, mimeType \}\) => \(\{ data, mimeType \}\)\),\s*\);/);

  // The poll fallback runs when SSE was lost: it settles the UI but cannot tell a
  // finished turn from a prompt_error it missed, so it must not confirm.
  assert.doesNotMatch(finishSource, /submissions\.|confirmPrompt/);

  // An aborted turn may never have recorded the prompt: it leaves the tracker and
  // the in-flight ref, so no later event confirms it and its draft stays pending.
  assert.match(abortSource, /const inFlight = agentRunningRef\.current \? inFlightPromptRef\.current : null;\s*if \(inFlight\) \{\s*submissions\.takeById\(inFlight\.promptId\);\s*inFlightPromptRef\.current = null;\s*\}\s*await sendAgentCommand\(sid, \{ type: "abort" \}\);/);

  // A definitive rejection (restored into the composer) and an ambiguous transport
  // failure (delivery unknown) both stop tracking the submission, so no event can
  // confirm it.
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{\s*(?:\/\/[^\n]*\n\s*)*submissions\.untrack\(submission\);\s*void waitForPromptSettlement\(sentSessionId, promptRunId\);\s*return;\s*\}/);
  assert.match(sendSource, /restoreFailedSubmission\(\s*"Failed to send message:"[\s\S]*?\);\s*(?:\/\/[^\n]*\n\s*)*submissions\.untrack\(submission\);/);
  assert.match(behaviorSource, /\} catch \(e\) \{\s*submissions\.untrack\(submission\);\s*restoreFailedSubmission\("Failed to queue prompt:", e, message, images, draftKey\);\s*\}/);

  // The server awaits a steer / follow-up queue call and emits no turn event for
  // it, so its HTTP success is the confirmation: it is never tracked, restored on
  // failure, confirmed right away otherwise.
  assert.doesNotMatch(steerSource + followUpSource, /submissions\./);
  assert.match(steerSource, /\} catch \(e\) \{[\s\S]*?restoreFailedSubmission\("Failed to steer:", e, message, images, draftKey\);\s*return;\s*\}\s*confirmQueuedDraft\(sid, draftKey, message\);/);
  assert.match(followUpSource, /\} catch \(e\) \{\s*restoreFailedSubmission\("Failed to follow up:", e, message, images, draftKey\);\s*return;\s*\}\s*confirmQueuedDraft\(sid, draftKey, message\);/);
  // A first send may have rekeyed the composer to the session id meanwhile.
  assert.match(confirmQueuedSource, /confirmDraft\(draftKey, message\);\s*if \(sessionId !== draftKey\) confirmDraft\(sessionId, message\);/);

  // A send the hook cannot start (agent or shell busy) hands the text back.
  assert.match(sendSource, /if \(agentRunningRef\.current \|\| bashRunningRef\.current\) \{[\s\S]*?restoreFailedSubmission\([\s\S]*?draftKey,\s*\);\s*return;/);
});

test("AppShell scopes persisted drafts to the resolved web user (#88)", () => {
  assert.match(appShellSource, /import \{ setDraftUser \} from "@\/lib\/draft-store";/);
  assert.match(
    appShellSource,
    /const webUsername = webUser\?\.username \?\? null;\s*useEffect\(\(\) => \{\s*setDraftUser\(webUsername\);\s*\}, \[webUsername\]\);/,
  );
});
