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

test("submitted drafts are settled only by a confirmed turn and kept otherwise (#88)", () => {
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
  const settleSource = source.slice(
    source.indexOf("  const settleSubmittedDrafts = useCallback"),
    source.indexOf("  const scheduleEventStreamClose = useCallback"),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );
  const queuedSource = source.slice(
    source.indexOf("  const handleSteer = useCallback"),
    source.indexOf("  const handleAbortCompaction = useCallback"),
  );

  // The hook never touches a draft itself: a tracker from the draft store owns
  // the (draft key, text) of every submission and confirms exactly those, so a
  // turn that was not confirmed (ambiguous, aborted, errored) stays on record
  // when a later turn in the same session is.
  assert.match(source, /import \{ createSubmissionTracker \} from "@\/lib\/draft-store";/);
  assert.match(source, /const \[submissions\] = useState\(createSubmissionTracker\);/);
  assert.doesNotMatch(source, /clearDraft|setDraft\(|confirmDraft/);

  // prompt_done / agent_settled confirm unless a prompt_error flagged the run
  // or the user aborted it (an aborted turn may never have recorded the prompt).
  assert.match(promptDoneSource, /settleSubmittedDrafts\(\)/);
  assert.match(agentSettledSource, /settleSubmittedDrafts\(\)/);
  // A prompt_done that arrives after the poll fallback settled the UI still confirms.
  assert.match(promptDoneSource, /settleSubmittedDrafts\(\);\s*const firstNotification = notifyPromptStage\(runId\);\s*if \(!promptWasPending && !firstNotification\) break;/);
  assert.match(settleSource, /const keepOnRecord = promptErroredRef\.current \|\| promptAbortedRef\.current;[\s\S]*?if \(keepOnRecord\) submissions\.keepOnRecord\(\);\s*else submissions\.confirm\(sessionIdRef\.current\);/);
  assert.match(source, /if \(agentRunningRef\.current\) promptAbortedRef\.current = true;\s*await sendAgentCommand\(sid, \{ type: "abort" \}\);/);
  assert.match(promptErrorSource, /promptErroredRef\.current = true;/);
  // A rejected prompt goes back to the composer instead of waiting for a reload.
  assert.match(promptErrorSource, /restoreInFlightPrompt\(\);/);
  assert.match(settleSource, /restoreSubmission\?\.\(\s*prompt\.message,[\s\S]*?\);/);

  // The poll fallback runs when SSE was lost: it settles the UI but cannot tell a
  // finished turn from a prompt_error it missed, so it must not confirm.
  assert.doesNotMatch(finishSource, /submissions\.confirm|settleSubmittedDrafts/);

  // Tracking starts when a send is dispatched. A definitive rejection (restored
  // into the composer) and an ambiguous transport failure (delivery unknown) both
  // stop tracking it, so no later turn can confirm it.
  assert.match(sendSource, /const submission = submissions\.track\(draftKey, message\);/);
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{\s*(?:\/\/[^\n]*\n\s*)*submissions\.untrack\(submission\);\s*void waitForPromptSettlement\(sentSessionId, promptRunId\);\s*return;\s*\}/);
  assert.match(sendSource, /restoreFailedSubmission\(\s*"Failed to send message:"[\s\S]*?\);\s*(?:\/\/[^\n]*\n\s*)*submissions\.untrack\(submission\);/);
  // Steer / follow-up / queued prompts are confirmed together with the run they
  // join, and untracked when the queue rejects them.
  assert.equal(queuedSource.match(/const submission = submissions\.track\(draftKey, message\);/g)?.length, 3);
  assert.equal(queuedSource.match(/submissions\.untrack\(submission\);\s*restoreFailedSubmission\(/g)?.length, 3);

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
