/**
 * Composer drafts.
 *
 * A draft is the text (and, for the current page life only, the images) the
 * user typed into a composer, keyed by the composer's draft key: the session id
 * for an existing conversation, `new:<cwd>` for one that does not exist yet.
 *
 * The module-level Map is a write-through cache over localStorage so a typed
 * prompt survives a reload (#70/#88). Persistence is text-only (images stay in
 * memory), namespaced per machine and per web user, and a record is deleted
 * only when its owner is certain the text is safe:
 *
 *   editing -> the composer text itself; deleted when the composer is emptied.
 *   pending -> `markDraftSubmitted` moved the composer text into a submission
 *              the server has not confirmed. Emptying the composer does NOT
 *              delete it; `confirmDraft` (turn confirmed) or
 *              `restoreDraftSubmission` (turn rejected) resolve it.
 *
 * Each submission is tracked by the session hook under a client-generated
 * `promptId` that the server echoes in that prompt's `prompt_done` /
 * `prompt_error` (`createSubmissionTracker`): only its own turn confirms it and
 * only its own failure restores it.
 *
 * A submission that was still pending when the page died is not guessed at on
 * the next load: its text comes back into the composer as an editable draft.
 *
 * Known limit (deferred, #70): there is no cross-tab sync. Every tab keeps its
 * own cache over the shared localStorage and nothing listens to `storage`
 * events. A tab that first reads a key while another tab still has a submission
 * pending under it cannot tell that record from one a dead page left (see
 * `load`): it turns the text into an editable draft, so a prompt the other tab
 * is about to confirm can come back in this one, and whichever tab writes last
 * wins. One draft key is not meant to be used from two tabs at once.
 */
import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";
import { machineStorageKey } from "./api-path";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

/**
 * - `editing`: plain composer text.
 * - `pending`: submitted, not yet confirmed by the server.
 * - `unverified`: a submission whose outcome could not be established. Valid in
 *   persisted records and treated like `pending` everywhere; no client path
 *   assigns it yet (server-side verification is tracked in #70).
 */
export type DraftStatus = "editing" | "pending" | "unverified";

/** The localStorage record. `text` is the composer text; `submittedText` the unconfirmed submission(s). */
export interface PersistedDraftRecord {
  v: 1;
  text: string;
  status: DraftStatus;
  submittedText?: string;
  submittedAt?: number;
  updatedAt: number;
}

export interface PendingDraftInfo {
  key: string;
  status: Exclude<DraftStatus, "editing">;
  text: string;
  submittedText: string;
  submittedAt?: number;
  updatedAt: number;
}

interface DraftEntry {
  draft: ChatDraft;
  status: DraftStatus;
  /** Unconfirmed submissions, oldest first. Empty exactly when `status` is `editing`. */
  submitted: string[];
  submittedAt: number | undefined;
  updatedAt: number;
}

const STORAGE_PREFIX = "omp-web:draft:v1:";
const ANONYMOUS_USER = "__anonymous";
/** Draft keys of a conversation that has no session id yet (ChatWindow builds `new:<cwd>`). */
const PROVISIONAL_KEY_PREFIX = "new:";
/** Text is capped when written; the in-memory draft always keeps the full text. */
export const MAX_PERSISTED_DRAFT_CHARS = 64 * 1024;
const PERSIST_DEBOUNCE_MS = 300;
const SUBMISSION_SEPARATOR = "\n\n";
/** A record written before the web user was known; the optional group is the `m:<machine>:` namespace. */
const ANONYMOUS_RECORD_KEY = /^((?:m:[^:]*:)?)omp-web:draft:v1:__anonymous:([\s\S]*)$/;

/** Cache of every draft touched this page life, keyed by full storage key (machine + user + draft key). */
const cache = new Map<string, DraftEntry>();
const dirty = new Set<string>();
const scopeListeners = new Set<() => void>();
let draftUser = ANONYMOUS_USER;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleFlushInstalled = false;

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

function newEntry(): DraftEntry {
  return {
    draft: { value: "", images: [] },
    status: "editing",
    submitted: [],
    submittedAt: undefined,
    updatedAt: Date.now(),
  };
}

/** Nothing to keep: no composer content and no unconfirmed submission. */
function isDisposable(entry: DraftEntry): boolean {
  return entry.status === "editing" && isEmptyDraft(entry.draft);
}

// ── storage ────────────────────────────────────────────────────────────────

function getStorage(): Storage | null {
  try {
    // `in` does not run the getter, so a throwing localStorage still lands in the catch.
    return "localStorage" in globalThis ? (globalThis.localStorage ?? null) : null;
  } catch {
    // Accessing localStorage throws in sandboxed/disabled-storage contexts.
    return null;
  }
}

function scopePrefix(): string {
  return machineStorageKey(`${STORAGE_PREFIX}${draftUser}:`);
}

function storageKey(key: string): string {
  return scopePrefix() + key;
}

function capPersistedText(text: string): string {
  if (text.length <= MAX_PERSISTED_DRAFT_CHARS) return text;
  let end = MAX_PERSISTED_DRAFT_CHARS;
  const last = text.charCodeAt(end - 1);
  // Do not cut a surrogate pair in half.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function toRecord(entry: DraftEntry): PersistedDraftRecord {
  const record: PersistedDraftRecord = {
    v: 1,
    text: capPersistedText(entry.draft.value),
    status: entry.status,
    updatedAt: entry.updatedAt,
  };
  if (entry.submitted.length > 0) {
    record.submittedText = capPersistedText(entry.submitted.join(SUBMISSION_SEPARATOR));
    if (entry.submittedAt !== undefined) record.submittedAt = entry.submittedAt;
  }
  return record;
}

function parseRecord(value: unknown): PersistedDraftRecord | null {
  if (!value || typeof value !== "object") return null;
  // Parsed JSON of unknown shape: every field is checked below before use.
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || typeof raw.text !== "string") return null;
  const record: PersistedDraftRecord = {
    v: 1,
    text: raw.text,
    status: raw.status === "pending" ? "pending" : raw.status === "unverified" ? "unverified" : "editing",
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
  if (typeof raw.submittedText === "string") record.submittedText = raw.submittedText;
  if (typeof raw.submittedAt === "number") record.submittedAt = raw.submittedAt;
  return record;
}

function readRecord(storageKeyValue: string): PersistedDraftRecord | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKeyValue);
    return raw === null ? null : parseRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeRecord(storageKeyValue: string, record: PersistedDraftRecord | null): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (record) storage.setItem(storageKeyValue, JSON.stringify(record));
    else storage.removeItem(storageKeyValue);
  } catch {
    // Quota exceeded or storage disabled: the in-memory cache still holds the
    // draft for this page life, which is the best that can be done.
  }
}

function persistEntry(storageKeyValue: string, entry: DraftEntry | undefined): void {
  if (!entry || (entry.draft.value === "" && entry.submitted.length === 0)) {
    writeRecord(storageKeyValue, null);
    return;
  }
  writeRecord(storageKeyValue, toRecord(entry));
}

export function flushDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const key of dirty) persistEntry(key, cache.get(key));
  dirty.clear();
}

function installLifecycleFlush(): void {
  if (lifecycleFlushInstalled) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  lifecycleFlushInstalled = true;
  window.addEventListener("pagehide", flushDrafts);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushDrafts();
    });
  }
}

function markDirty(key: string): void {
  if (!getStorage()) return;
  dirty.add(key);
  installLifecycleFlush();
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flushDrafts, PERSIST_DEBOUNCE_MS);
}

/** Stores `entry` (or drops it when there is nothing left to keep). `immediate` skips the debounce. */
function commit(key: string, entry: DraftEntry, immediate: boolean): void {
  if (isDisposable(entry)) {
    cache.delete(key);
    dirty.delete(key);
    persistEntry(key, undefined);
    return;
  }
  cache.set(key, entry);
  if (immediate) {
    dirty.delete(key);
    persistEntry(key, entry);
  } else {
    markDirty(key);
  }
}

function entryFromRecord(record: PersistedDraftRecord): DraftEntry {
  // A submission still unconfirmed when the previous page life ended is not
  // guessed at: its text returns to the composer, ahead of anything typed later.
  const text = record.status === "editing"
    ? record.text
    : mergeRestoredSubmissionText(record.submittedText ?? "", record.text);
  return {
    draft: { value: text, images: [] },
    status: "editing",
    submitted: [],
    submittedAt: undefined,
    updatedAt: record.updatedAt || Date.now(),
  };
}

/**
 * Cache hit, else hydrate from localStorage. A never-seen key stays out of the cache.
 *
 * A record still `pending` on disk is taken for one a dead page left behind: a
 * submission of this page life is always cached already. Its text returns as
 * an editable draft and the record is rewritten to say so. A live second tab's
 * pending submission looks the same and is converted the same way (the known
 * second-tab limit in the module header).
 */
function load(key: string): DraftEntry | undefined {
  const storageId = storageKey(key);
  const cached = cache.get(storageId);
  if (cached) return cached;

  const record = readRecord(storageId);
  if (!record) return undefined;
  const entry = entryFromRecord(record);
  if (isDisposable(entry)) {
    writeRecord(storageId, null);
    return undefined;
  }
  cache.set(storageId, entry);
  // The restored text is editable now; rewrite the record so it says so.
  if (record.status !== "editing") markDirty(storageId);
  return entry;
}

// ── public API ─────────────────────────────────────────────────────────────

export function getDraft(key: string): ChatDraft | null {
  const entry = load(key);
  return entry && !isEmptyDraft(entry.draft) ? cloneDraft(entry.draft) : null;
}

/**
 * Stores the composer content. Emptying the composer deletes an `editing`
 * draft but never a `pending`/`unverified` one: the submitted text outlives
 * the composer until it is confirmed or restored.
 */
export function setDraft(key: string, draft: ChatDraft): void {
  const storageId = storageKey(key);
  if (isEmptyDraft(draft)) {
    const cached = cache.get(storageId);
    if (cached) {
      if (isEmptyDraft(cached.draft)) return;
      cached.draft = { value: "", images: [] };
      cached.updatedAt = Date.now();
      commit(storageId, cached, false);
      return;
    }
    // Not loaded this page life: a stored `editing` draft is deleted, but a
    // stored pending submission is not ours to drop on a blind empty write.
    if (readRecord(storageId)?.status === "editing") writeRecord(storageId, null);
    return;
  }
  const entry = load(key);
  const target = entry ?? newEntry();
  target.draft = cloneDraft(draft);
  target.updatedAt = Date.now();
  commit(storageId, target, false);
}

/** Forgets the draft and any unconfirmed submission under `key` immediately. */
export function clearDraft(key: string): void {
  const storageId = storageKey(key);
  cache.delete(storageId);
  dirty.delete(storageId);
  writeRecord(storageId, null);
}

/**
 * The composer text under `key` left for the server. The composer draft is
 * emptied, but `submittedText` stays on record as `pending` (written to storage
 * synchronously) until `confirmDraft` or `restoreDraftSubmission`.
 */
export function markDraftSubmitted(key: string, submittedText: string): void {
  const entry = load(key) ?? newEntry();
  entry.draft = { value: "", images: [] };
  if (submittedText.trim()) {
    if (entry.status === "editing") entry.status = "pending";
    entry.submitted.push(submittedText);
    entry.submittedAt = Date.now();
  }
  entry.updatedAt = Date.now();
  commit(storageKey(key), entry, true);
}

/**
 * Removes the newest unconfirmed submission whose text matches `text`. Returns
 * false when none does, leaving the entry untouched.
 */
function takeSubmission(entry: DraftEntry, text: string): boolean {
  const wanted = text.trim();
  for (let index = entry.submitted.length - 1; index >= 0; index -= 1) {
    if (entry.submitted[index].trim() !== wanted) continue;
    entry.submitted.splice(index, 1);
    if (entry.submitted.length === 0) {
      entry.status = "editing";
      entry.submittedAt = undefined;
    }
    return true;
  }
  return false;
}

/**
 * The server confirmed a turn: drop the unconfirmed submission(s) under `key`.
 * With `submittedText` only that submission goes (a different, still unconfirmed
 * one stays on record); without it every pending submission under `key` does.
 * Text typed into the composer since stays as a plain draft.
 */
export function confirmDraft(key: string, submittedText?: string): void {
  const storageId = storageKey(key);
  const entry = cache.get(storageId);
  if (entry) {
    if (entry.status === "editing") return;
    if (submittedText === undefined) {
      entry.status = "editing";
      entry.submitted = [];
      entry.submittedAt = undefined;
    } else if (!takeSubmission(entry, submittedText)) {
      return;
    }
    entry.updatedAt = Date.now();
    commit(storageId, entry, true);
    return;
  }

  // A submission of this page life is always cached; anything only on disk was
  // left by an earlier life or another tab, and only a blanket confirm settles it.
  if (submittedText !== undefined) return;
  const record = readRecord(storageId);
  if (!record || record.status === "editing") return;
  writeRecord(
    storageId,
    record.text ? { v: 1, text: record.text, status: "editing", updatedAt: Date.now() } : null,
  );
}

export function getDraftStatus(key: string): DraftStatus | null {
  const storageId = storageKey(key);
  return cache.get(storageId)?.status ?? readRecord(storageId)?.status ?? null;
}

/** Unconfirmed submissions for the current machine and user, oldest first. */
export function getPendingDrafts(): PendingDraftInfo[] {
  const prefix = scopePrefix();
  const pending: PendingDraftInfo[] = [];
  for (const [storageId, entry] of cache) {
    if (!storageId.startsWith(prefix) || entry.status === "editing") continue;
    pending.push({
      key: storageId.slice(prefix.length),
      status: entry.status,
      text: entry.draft.value,
      submittedText: entry.submitted.join(SUBMISSION_SEPARATOR),
      ...(entry.submittedAt !== undefined ? { submittedAt: entry.submittedAt } : {}),
      updatedAt: entry.updatedAt,
    });
  }

  const storage = getStorage();
  if (storage) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const storageId = storage.key(index);
        if (!storageId || !storageId.startsWith(prefix) || cache.has(storageId)) continue;
        const record = readRecord(storageId);
        if (!record || record.status === "editing") continue;
        pending.push({
          key: storageId.slice(prefix.length),
          status: record.status,
          text: record.text,
          submittedText: record.submittedText ?? "",
          ...(record.submittedAt !== undefined ? { submittedAt: record.submittedAt } : {}),
          updatedAt: record.updatedAt,
        });
      }
    } catch {
      // Enumeration is best effort.
    }
  }
  return pending.sort(
    (a, b) => (a.submittedAt ?? a.updatedAt) - (b.submittedAt ?? b.updatedAt),
  );
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
  };
}

/**
 * Text read from storage after a composer already exists (the web user, and so
 * the storage scope, resolved after mount): the stored text first, then what
 * was typed meanwhile, without repeating text that is already part of the other.
 */
export function reconcileHydratedDraftText(stored: string, current: string): string {
  if (!stored.trim() || stored === current) return current;
  if (!current.trim()) return stored;
  if (stored.includes(current)) return stored;
  if (current.includes(stored)) return current;
  return mergeRestoredSubmissionText(stored, current);
}

/** A submitted text was rejected: forget it as an unconfirmed submission (the caller restores the text). */
function releaseSubmission(key: string, text: string): void {
  const storageId = storageKey(key);
  const entry = cache.get(storageId);
  if (!entry || entry.status === "editing" || !takeSubmission(entry, text)) return;
  entry.updatedAt = Date.now();
  commit(storageId, entry, true);
}

/**
 * A submission was rejected. Puts `text`/`images` back in front of whatever is
 * in the composer (`currentDraft`, or the stored draft when the composer is not
 * the live one), persists the result synchronously and releases the submission
 * from the unconfirmed set.
 */
export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
  currentDraft?: ChatDraft,
): ChatDraft {
  const current = currentDraft ?? getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
  );
  setDraft(key, restored);
  releaseSubmission(key, text);
  return restored;
}

/** True for the draft key of a conversation that has no session id yet. */
export function isProvisionalDraftKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(PROVISIONAL_KEY_PREFIX);
}

/** A composer submission a session hook dispatched and has not seen confirmed yet. */
export interface TrackedSubmission {
  readonly draftKey: string;
  readonly text: string;
  /** Client-generated id the server echoes in this prompt's `prompt_done` / `prompt_error`. */
  readonly promptId: string;
}

/**
 * What a session hook keeps about the submissions it dispatched, so that only
 * the turn that carried a submission settles it (#88). An event for another id
 * (another tab's prompt, a queued slash command, a stale or late event) or
 * without one (an older remote) never confirms or restores a submission that
 * is not its own.
 */
export interface SubmissionTracker {
  /** Starts tracking. Returns `null` when there is nothing durable to track: no draft key, no id, or no text (images are never kept). */
  track(draftKey: string | undefined, text: string, promptId: string): TrackedSubmission | null;
  /**
   * Stops tracking a submission whose delivery is unknown or that was rejected
   * (the caller restores its text): it stays on record and no turn may confirm it.
   */
  untrack(submission: TrackedSubmission | null): void;
  /**
   * Stops tracking and returns the submission dispatched under `promptId`;
   * `null` when this tracker holds none (not its prompt, already settled, or no
   * id at all). The submission stays on record: the caller restores its text
   * or leaves it pending (an aborted turn).
   */
  takeById(promptId: string | undefined): TrackedSubmission | null;
  /**
   * The turn of `promptId` was confirmed: confirms exactly that submission,
   * under the draft it was taken from and under `sessionId`, where a promoted
   * new conversation's draft lives by now. Every other submission, one under
   * the same draft key included, stays pending.
   */
  confirm(sessionId: string | null, promptId: string | undefined): void;
}

export function createSubmissionTracker(): SubmissionTracker {
  let tracked: TrackedSubmission[] = [];
  const takeById = (promptId: string | undefined): TrackedSubmission | null => {
    if (!promptId) return null;
    const submission = tracked.find((candidate) => candidate.promptId === promptId);
    if (!submission) return null;
    tracked = tracked.filter((candidate) => candidate !== submission);
    return submission;
  };
  return {
    track(draftKey, text, promptId) {
      if (!draftKey || !promptId || !text.trim()) return null;
      const submission = { draftKey, text, promptId };
      tracked.push(submission);
      return submission;
    },
    untrack(submission) {
      if (submission) tracked = tracked.filter((candidate) => candidate !== submission);
    },
    takeById,
    confirm(sessionId, promptId) {
      const submission = takeById(promptId);
      if (!submission) return;
      confirmDraft(submission.draftKey, submission.text);
      if (sessionId && sessionId !== submission.draftKey) confirmDraft(sessionId, submission.text);
    },
  };
}

/**
 * Moves the draft (and any unconfirmed submission) from `previousKey` to
 * `nextKey`, leaving `previousKey` empty. `currentDraft` is the live composer
 * content when it may be fresher than the store.
 */
export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const previousEntry = load(previousKey);
  const storedPrevious = previousEntry && !isEmptyDraft(previousEntry.draft)
    ? cloneDraft(previousEntry.draft)
    : null;
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const carried = previousEntry && previousEntry.status !== "editing" ? previousEntry : null;
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous && !carried) return next;

  const merged = previous && next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
    : (previous ?? next);
  const target = load(nextKey) ?? newEntry();
  if (merged) target.draft = cloneDraft(merged);
  if (carried) {
    if (target.status === "editing") target.status = carried.status;
    target.submitted = [...carried.submitted, ...target.submitted];
    target.submittedAt = carried.submittedAt ?? target.submittedAt;
  }
  target.updatedAt = Date.now();
  commit(storageKey(nextKey), target, true);
  return merged ? cloneDraft(merged) : null;
}

// ── web-user scope ─────────────────────────────────────────────────────────

function mergeMigratedRecords(
  destination: PersistedDraftRecord,
  source: PersistedDraftRecord,
): PersistedDraftRecord {
  const submittedText = [destination.submittedText, source.submittedText]
    .filter((text): text is string => Boolean(text))
    .join(SUBMISSION_SEPARATOR);
  const submittedAt = destination.submittedAt ?? source.submittedAt;
  return {
    v: 1,
    text: destination.text === source.text
      ? destination.text
      : mergeRestoredSubmissionText(destination.text, source.text),
    status: destination.status !== "editing" ? destination.status : source.status,
    ...(submittedText ? { submittedText } : {}),
    ...(submittedAt !== undefined ? { submittedAt } : {}),
    updatedAt: Math.max(destination.updatedAt, source.updatedAt),
  };
}

/** Draft entry for what an earlier page life left on disk (`undefined` when nothing readable is there). */
function storedEntry(storageId: string): DraftEntry | undefined {
  const record = readRecord(storageId);
  return record ? entryFromRecord(record) : undefined;
}

/** `live` is this page life's entry for a key that also has `existing` content: `existing` text first. */
function mergeLiveEntries(existing: DraftEntry, live: DraftEntry): DraftEntry {
  const draft = mergeRestoredSubmissionDraft(
    existing.draft.value,
    existing.draft.images,
    live.draft.value,
    live.draft.images,
  );
  draft.value = reconcileHydratedDraftText(existing.draft.value, live.draft.value);
  return {
    draft,
    status: live.status !== "editing" ? live.status : existing.status,
    submitted: [...existing.submitted, ...live.submitted],
    submittedAt: existing.submittedAt ?? live.submittedAt,
    updatedAt: Math.max(existing.updatedAt, live.updatedAt),
  };
}

/**
 * Moves everything written before the web user was known under the user's own
 * scope. Entries of this page life move with their status and unconfirmed
 * submissions, so a send still in flight stays pending (and out of the
 * composer) instead of being re-read from disk as a dead page's leftover.
 */
function migrateAnonymousDrafts(): void {
  for (const [anonymousId, live] of [...cache]) {
    const match = ANONYMOUS_RECORD_KEY.exec(anonymousId);
    if (!match) continue;
    const destinationId = `${match[1]}${STORAGE_PREFIX}${draftUser}:${match[2]}`;
    cache.delete(anonymousId);
    dirty.delete(anonymousId);
    writeRecord(anonymousId, null);
    const existing = cache.get(destinationId) ?? storedEntry(destinationId);
    commit(destinationId, existing ? mergeLiveEntries(existing, live) : live, true);
  }

  // What earlier page lives left under the anonymous scope moves as plain records.
  const storage = getStorage();
  if (!storage) return;
  const sourceKeys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const storageId = storage.key(index);
      if (storageId && ANONYMOUS_RECORD_KEY.test(storageId)) sourceKeys.push(storageId);
    }
  } catch {
    // Enumeration failed: nothing can be moved.
  }
  for (const sourceKey of sourceKeys) {
    const match = ANONYMOUS_RECORD_KEY.exec(sourceKey);
    const source = readRecord(sourceKey);
    if (!match || !source) continue;
    const destinationKey = `${match[1]}${STORAGE_PREFIX}${draftUser}:${match[2]}`;
    try {
      const existing = readRecord(destinationKey);
      storage.setItem(
        destinationKey,
        JSON.stringify(existing ? mergeMigratedRecords(existing, source) : source),
      );
      storage.removeItem(sourceKey);
    } catch {
      // This record stays under the anonymous scope.
    }
  }
}

/**
 * Scopes persisted drafts to the signed-in web user (`null` = no user / auth
 * off). Called once `/api/auth/web-me` resolves; drafts written before that
 * under the anonymous scope move to the user's scope.
 */
export function setDraftUser(username: string | null): void {
  const next = username ? encodeURIComponent(username) : ANONYMOUS_USER;
  if (next === draftUser) return;
  const previous = draftUser;
  // Whatever was typed under the previous scope must be on disk before it moves.
  flushDrafts();
  draftUser = next;
  if (previous === ANONYMOUS_USER) migrateAnonymousDrafts();
  for (const listener of [...scopeListeners]) listener();
}

/**
 * Notified when the storage scope changes, i.e. when drafts that mounted
 * composers could not see yet became readable.
 */
export function subscribeDraftScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => {
    scopeListeners.delete(listener);
  };
}

/**
 * Test-only: forgets every in-memory draft and the user scope (as a page
 * reload does) while leaving localStorage untouched. Does not flush first.
 */
export function resetDraftStoreForTests(): void {
  cache.clear();
  dirty.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  draftUser = ANONYMOUS_USER;
  lifecycleFlushInstalled = false;
}
