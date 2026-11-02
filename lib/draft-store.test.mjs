import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const store = await import("./draft-store.ts");
const { LOCAL_MACHINE_ID, setCurrentMachineId } = await import("./api-path.ts");

const IMAGE = { data: "AQID", mimeType: "image/png" };
const empty = () => ({ value: "", images: [] });
const draft = (value, images = []) => ({ value, images });
/** Storage key of a draft on the local machine. */
const keyOf = (draftKey, user = "__anonymous") => `omp-web:draft:v1:${user}:${draftKey}`;

function createStorage() {
  const data = new Map();
  const storage = {
    failWrites: false,
    get length() {
      return data.size;
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (storage.failWrites) throw new Error("QuotaExceededError");
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    keys() {
      return [...data.keys()];
    },
  };
  return storage;
}

let storage;
const record = (draftKey, user) => JSON.parse(storage.getItem(keyOf(draftKey, user)));

beforeEach(() => {
  storage = createStorage();
  globalThis.localStorage = storage;
  setCurrentMachineId(LOCAL_MACHINE_ID);
  store.resetDraftStoreForTests();
});

afterEach(() => {
  store.resetDraftStoreForTests();
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.document;
  setCurrentMachineId(LOCAL_MACHINE_ID);
});

/** Persists everything and forgets the cache, as a reload does. */
function reload() {
  store.flushDrafts();
  store.resetDraftStoreForTests();
}

// ── persistence ────────────────────────────────────────────────────────────

test("persists text only and hydrates it after a reload", () => {
  store.setDraft("s1", draft("hello", [IMAGE]));

  // Within this page life the images are still there.
  assert.deepEqual(store.getDraft("s1"), draft("hello", [IMAGE]));
  store.flushDrafts();
  assert.equal(record("s1").v, 1);
  assert.equal(record("s1").text, "hello");
  assert.equal(record("s1").status, "editing");
  assert.equal(storage.getItem(keyOf("s1")).includes(IMAGE.data), false);

  reload();
  assert.deepEqual(store.getDraft("s1"), draft("hello"));
});

test("debounces typing writes and flushes them on the timer", async () => {
  store.setDraft("s1", draft("h"));
  store.setDraft("s1", draft("he"));
  store.setDraft("s1", draft("hel"));
  assert.equal(storage.getItem(keyOf("s1")), null);

  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(record("s1").text, "hel");
});

test("flushes synchronously on pagehide and when the page becomes hidden", () => {
  const windowListeners = new Map();
  const documentListeners = new Map();
  globalThis.window = { addEventListener: (type, listener) => windowListeners.set(type, listener) };
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (type, listener) => documentListeners.set(type, listener),
  };

  store.setDraft("s1", draft("typed"));
  assert.equal(storage.getItem(keyOf("s1")), null);
  windowListeners.get("pagehide")();
  assert.equal(record("s1").text, "typed");

  store.setDraft("s1", draft("typed more"));
  documentListeners.get("visibilitychange")();
  assert.equal(record("s1").text, "typed", "a visible page does not flush");
  globalThis.document.visibilityState = "hidden";
  documentListeners.get("visibilitychange")();
  assert.equal(record("s1").text, "typed more");
});

test("removes the record as soon as an editing draft is emptied or cleared", () => {
  store.setDraft("s1", draft("hello"));
  store.setDraft("s2", draft("world"));
  store.flushDrafts();

  store.setDraft("s1", empty());
  assert.equal(storage.getItem(keyOf("s1")), null);
  assert.equal(store.getDraft("s1"), null);

  store.clearDraft("s2");
  assert.equal(storage.getItem(keyOf("s2")), null);
  reload();
  assert.equal(store.getDraft("s2"), null);
});

test("an image-only draft is kept in memory but leaves nothing on disk", () => {
  store.setDraft("s1", draft("", [IMAGE]));
  store.flushDrafts();

  assert.deepEqual(store.getDraft("s1"), draft("", [IMAGE]));
  assert.equal(storage.getItem(keyOf("s1")), null);
});

test("caps persisted text at 64 KB while memory keeps the full draft", () => {
  const text = "a".repeat(70 * 1024);
  store.setDraft("s1", draft(text));
  store.flushDrafts();

  assert.equal(record("s1").text.length, store.MAX_PERSISTED_DRAFT_CHARS);
  assert.equal(store.MAX_PERSISTED_DRAFT_CHARS, 64 * 1024);
  assert.equal(store.getDraft("s1").value.length, 70 * 1024);

  const emoji = `x${"😀".repeat(40_000)}`;
  store.setDraft("s2", draft(emoji));
  store.flushDrafts();
  const stored = record("s2").text;
  const last = stored.charCodeAt(stored.length - 1);
  assert.equal(last >= 0xd800 && last <= 0xdbff, false, "never ends on half a surrogate pair");
});

test("ignores corrupt and foreign-version records", () => {
  storage.setItem(keyOf("junk"), "{not json");
  storage.setItem(keyOf("future"), JSON.stringify({ v: 2, text: "from the future", status: "editing", updatedAt: 1 }));
  storage.setItem(keyOf("shapeless"), JSON.stringify({ v: 1, text: 42 }));

  assert.equal(store.getDraft("junk"), null);
  assert.equal(store.getDraft("future"), null);
  assert.equal(store.getDraft("shapeless"), null);
  assert.ok(storage.getItem(keyOf("future")), "a record this version cannot read is left alone");
});

// ── failures ───────────────────────────────────────────────────────────────

test("quota failures never throw and the draft stays in memory", () => {
  storage.failWrites = true;

  assert.doesNotThrow(() => {
    store.setDraft("s1", draft("keep me"));
    store.flushDrafts();
    store.markDraftSubmitted("s2", "sent");
    store.confirmDraft("s2");
    store.clearDraft("s3");
  });
  assert.deepEqual(store.getDraft("s1"), draft("keep me"));

  // A scope change with unwritable storage leaves the records where they were.
  assert.doesNotThrow(() => store.setDraftUser("alice"));
  assert.equal(storage.getItem(keyOf("s2", "alice")), null);
});

test("a localStorage that throws on access never breaks the store", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });

  assert.doesNotThrow(() => {
    store.setDraft("s1", draft("still works"));
    store.markDraftSubmitted("s1", "sent");
    store.flushDrafts();
    store.getPendingDrafts();
    store.setDraftUser("alice");
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: undefined });
});

test("works without any localStorage (server render, bun test)", () => {
  delete globalThis.localStorage;

  store.setDraft("s1", draft("memory only"));
  assert.deepEqual(store.getDraft("s1"), draft("memory only"));
  store.markDraftSubmitted("s1", "sent");
  assert.equal(store.getDraftStatus("s1"), "pending");
  assert.deepEqual(store.getPendingDrafts().map((pending) => pending.key), ["s1"]);
});

// ── pending lifecycle ──────────────────────────────────────────────────────

test("markDraftSubmitted persists a pending record synchronously and empties the composer", () => {
  store.setDraft("new:/work", draft("first prompt"));
  store.markDraftSubmitted("new:/work", "first prompt");

  assert.equal(store.getDraft("new:/work"), null);
  assert.equal(store.getDraftStatus("new:/work"), "pending");
  const saved = record("new:/work");
  assert.equal(saved.status, "pending");
  assert.equal(saved.text, "");
  assert.equal(saved.submittedText, "first prompt");
  assert.equal(typeof saved.submittedAt, "number");
});

test("emptying the composer never deletes a pending submission", () => {
  store.markDraftSubmitted("new:/work", "first prompt");

  store.setDraft("new:/work", empty());
  store.flushDrafts();
  assert.equal(record("new:/work").submittedText, "first prompt");
  assert.equal(store.getDraftStatus("new:/work"), "pending");

  // Nor does a blind empty write for a pending record this page life never loaded.
  reload();
  store.setDraft("new:/work", empty());
  assert.equal(record("new:/work").status, "pending");
  assert.equal(record("new:/work").submittedText, "first prompt");
});

test("confirmDraft removes the pending record", () => {
  store.markDraftSubmitted("s1", "sent");
  store.confirmDraft("s1");

  assert.equal(storage.getItem(keyOf("s1")), null);
  assert.equal(store.getDraftStatus("s1"), null);
  assert.equal(store.getDraft("s1"), null);
  assert.deepEqual(store.getPendingDrafts(), []);
});

test("confirmDraft keeps text typed after the send as a plain draft", () => {
  store.markDraftSubmitted("s1", "sent");
  store.setDraft("s1", draft("typed while waiting"));
  store.confirmDraft("s1");

  assert.deepEqual(store.getDraft("s1"), draft("typed while waiting"));
  assert.equal(store.getDraftStatus("s1"), "editing");
  assert.equal(record("s1").status, "editing");
  assert.equal(record("s1").submittedText, undefined);
});

test("confirmDraft on a draft with no pending submission changes nothing", () => {
  store.setDraft("s1", draft("still typing"));
  store.confirmDraft("s1");
  store.confirmDraft("never-seen");

  assert.deepEqual(store.getDraft("s1"), draft("still typing"));
  assert.equal(store.getDraftStatus("s1"), "editing");
});

test("confirmDraft settles a pending record this page life never loaded", () => {
  store.markDraftSubmitted("s1", "sent");
  store.setDraft("s1", draft("typed since"));
  reload();

  store.confirmDraft("s1");
  assert.equal(record("s1").status, "editing");
  assert.equal(record("s1").text, "typed since");
  assert.equal(record("s1").submittedText, undefined);

  store.markDraftSubmitted("s2", "sent");
  reload();
  store.confirmDraft("s2");
  assert.equal(storage.getItem(keyOf("s2")), null);
});

test("confirming one turn leaves an earlier unconfirmed submission on record", () => {
  store.markDraftSubmitted("s1", "possibly undelivered prompt");
  store.markDraftSubmitted("s1", "second prompt");

  store.confirmDraft("s1", "second prompt");
  assert.equal(store.getDraftStatus("s1"), "pending");
  assert.equal(record("s1").submittedText, "possibly undelivered prompt");

  // Text that was never submitted, or only exists on disk, confirms nothing.
  store.confirmDraft("s1", "never submitted");
  reload();
  store.confirmDraft("s1", "possibly undelivered prompt");
  assert.equal(record("s1").submittedText, "possibly undelivered prompt");

  // Matching ignores surrounding whitespace, and the last one out removes the record.
  store.markDraftSubmitted("s2", "only prompt");
  store.confirmDraft("s2", "  only prompt\n");
  assert.equal(storage.getItem(keyOf("s2")), null);
});

test("confirming a repeated prompt removes only the newest matching submission", () => {
  store.markDraftSubmitted("s1", "continue");
  store.markDraftSubmitted("s1", "continue");

  store.confirmDraft("s1", "continue");
  assert.equal(record("s1").submittedText, "continue");
  store.confirmDraft("s1", "continue");
  assert.equal(storage.getItem(keyOf("s1")), null);
});

test("a submission still pending when the page died returns as editable text", () => {
  store.markDraftSubmitted("s1", "unconfirmed prompt");
  store.setDraft("s1", draft("typed afterwards"));
  reload();

  assert.deepEqual(store.getDraft("s1"), draft("unconfirmed prompt\n\ntyped afterwards"));
  assert.equal(store.getDraftStatus("s1"), "editing");
  store.flushDrafts();
  assert.equal(record("s1").status, "editing");
  assert.equal(record("s1").text, "unconfirmed prompt\n\ntyped afterwards");
  assert.equal(record("s1").submittedText, undefined);
});

test("restoreDraftSubmission puts a rejected prompt back in front of typed text and resolves it", () => {
  store.markDraftSubmitted("new:/work", "first prompt");
  store.setDraft("new:/work", draft("typed meanwhile"));

  const restored = store.restoreDraftSubmission("new:/work", "first prompt");
  assert.deepEqual(restored, draft("first prompt\n\ntyped meanwhile"));
  assert.deepEqual(store.getDraft("new:/work"), restored);
  assert.equal(store.getDraftStatus("new:/work"), "editing");
  // Written without waiting for the debounce.
  assert.equal(record("new:/work").text, "first prompt\n\ntyped meanwhile");
  assert.equal(record("new:/work").submittedText, undefined);
});

test("restoreDraftSubmission merges against the live composer when given one", () => {
  store.markDraftSubmitted("s1", "queued");

  const restored = store.restoreDraftSubmission("s1", "queued", [IMAGE], draft("live text", [IMAGE]));
  assert.deepEqual(restored, draft("queued\n\nlive text", [IMAGE, IMAGE]));
  assert.deepEqual(store.getDraft("s1"), restored);
});

test("restoring one of several unconfirmed submissions keeps the others pending", () => {
  store.markDraftSubmitted("s1", "prompt");
  store.markDraftSubmitted("s1", "steer message");
  assert.equal(record("s1").submittedText, "prompt\n\nsteer message");

  store.restoreDraftSubmission("s1", "steer message");
  assert.equal(store.getDraftStatus("s1"), "pending");
  assert.equal(record("s1").submittedText, "prompt");
  assert.deepEqual(store.getDraft("s1"), draft("steer message"));

  store.confirmDraft("s1");
  assert.equal(store.getDraftStatus("s1"), "editing");
  assert.deepEqual(store.getDraft("s1"), draft("steer message"));
});

test("a failed first send lands in the visible new: draft and survives a reload (#88)", () => {
  store.setDraft("new:/work", draft("first prompt"));
  store.markDraftSubmitted("new:/work", "first prompt");
  assert.equal(store.getDraft("new:/work"), null);

  // The failure handler targets the key the composer is showing, never the
  // freshly created session id.
  store.restoreDraftSubmission("new:/work", "first prompt");
  assert.deepEqual(store.getDraft("new:/work"), draft("first prompt"));
  assert.equal(store.getDraft("session-created-by-ensure"), null);

  reload();
  assert.deepEqual(store.getDraft("new:/work"), draft("first prompt"));
});

test("an unverified record is treated like a pending one", () => {
  storage.setItem(keyOf("s1"), JSON.stringify({
    v: 1,
    text: "",
    status: "unverified",
    submittedText: "could not verify",
    submittedAt: 5,
    updatedAt: 5,
  }));

  assert.equal(store.getDraftStatus("s1"), "unverified");
  assert.deepEqual(store.getPendingDrafts().map((pending) => [pending.key, pending.status]), [["s1", "unverified"]]);
  store.setDraft("s1", empty());
  assert.equal(record("s1").status, "unverified");
  assert.deepEqual(store.getDraft("s1"), draft("could not verify"));
});

test("getPendingDrafts lists unconfirmed submissions of this scope, oldest first", () => {
  storage.setItem(keyOf("older"), JSON.stringify({
    v: 1, text: "", status: "pending", submittedText: "from an earlier page", submittedAt: 10, updatedAt: 10,
  }));
  storage.setItem(keyOf("other-user", "alice"), JSON.stringify({
    v: 1, text: "", status: "pending", submittedText: "someone else", submittedAt: 1, updatedAt: 1,
  }));
  storage.setItem(keyOf("plain"), JSON.stringify({ v: 1, text: "just editing", status: "editing", updatedAt: 2 }));
  store.markDraftSubmitted("newer", "this page");
  store.setDraft("typing", draft("not submitted"));

  const pending = store.getPendingDrafts();
  assert.deepEqual(pending.map((entry) => entry.key), ["older", "newer"]);
  assert.equal(pending[0].submittedText, "from an earlier page");
  assert.equal(pending[1].submittedText, "this page");
  assert.equal(pending[1].status, "pending");
});

test("an empty pending record is dropped instead of restored", () => {
  storage.setItem(keyOf("s1"), JSON.stringify({ v: 1, text: "", status: "pending", updatedAt: 1 }));

  assert.equal(store.getDraft("s1"), null);
  assert.equal(storage.getItem(keyOf("s1")), null);
});

// ── rekey ──────────────────────────────────────────────────────────────────

test("rekeyDraft moves the composer text and a pending submission exactly once", () => {
  store.markDraftSubmitted("new:/work", "first prompt");
  store.setDraft("new:/work", draft("typed meanwhile"));

  const moved = store.rekeyDraft("new:/work", "session-1", draft("typed meanwhile"));
  assert.deepEqual(moved, draft("typed meanwhile"));

  // The provisional key is empty everywhere.
  assert.equal(store.getDraft("new:/work"), null);
  assert.equal(store.getDraftStatus("new:/work"), null);
  assert.equal(storage.getItem(keyOf("new:/work")), null);
  // The session key carries both.
  assert.deepEqual(store.getDraft("session-1"), draft("typed meanwhile"));
  assert.equal(store.getDraftStatus("session-1"), "pending");
  assert.equal(record("session-1").submittedText, "first prompt");

  // A second rekey has nothing left to move.
  store.rekeyDraft("new:/work", "session-1");
  assert.deepEqual(store.getDraft("session-1"), draft("typed meanwhile"));
  assert.equal(record("session-1").submittedText, "first prompt");

  store.confirmDraft("session-1");
  assert.deepEqual(store.getDraft("session-1"), draft("typed meanwhile"));
  assert.equal(store.getDraftStatus("session-1"), "editing");
});

test("rekeyDraft moves a pending submission even when the composer is empty", () => {
  store.markDraftSubmitted("new:/work", "first prompt");

  assert.deepEqual(store.rekeyDraft("new:/work", "session-1", empty()), empty());
  assert.equal(storage.getItem(keyOf("new:/work")), null);
  assert.equal(store.getDraftStatus("session-1"), "pending");
  assert.equal(record("session-1").submittedText, "first prompt");

  store.confirmDraft("session-1");
  assert.equal(storage.getItem(keyOf("session-1")), null);
});

test("rekeyDraft puts the moved text after the target's own draft", () => {
  store.setDraft("new:/work", draft("from provisional"));
  store.setDraft("session-1", draft("already there"));

  assert.deepEqual(
    store.rekeyDraft("new:/work", "session-1"),
    draft("already there\n\nfrom provisional"),
  );
  assert.equal(store.getDraft("new:/work"), null);
});

test("a rekeyed draft survives a reload under the new key only", () => {
  store.setDraft("new:/work", draft("keep"));
  store.flushDrafts();
  store.rekeyDraft("new:/work", "session-1");
  reload();

  assert.equal(store.getDraft("new:/work"), null);
  assert.deepEqual(store.getDraft("session-1"), draft("keep"));
});

test("recognises provisional draft keys", () => {
  assert.equal(store.isProvisionalDraftKey("new:/work"), true);
  assert.equal(store.isProvisionalDraftKey("3f2a9c"), false);
  assert.equal(store.isProvisionalDraftKey(undefined), false);
  assert.equal(store.isProvisionalDraftKey(null), false);
});

// ── machine and user scope ─────────────────────────────────────────────────

test("namespaces records per machine", () => {
  setCurrentMachineId("boxtwo");
  store.setDraft("s1", draft("on boxtwo"));
  store.flushDrafts();

  assert.deepEqual(storage.keys(), ["m:boxtwo:omp-web:draft:v1:__anonymous:s1"]);
  setCurrentMachineId(LOCAL_MACHINE_ID);
  assert.equal(store.getDraft("s1"), null, "the local machine does not see boxtwo's draft");

  store.setDraft("s1", draft("on local"));
  setCurrentMachineId("boxtwo");
  assert.deepEqual(store.getDraft("s1"), draft("on boxtwo"));
  reload();
  assert.deepEqual(store.getDraft("s1"), draft("on boxtwo"));
  setCurrentMachineId(LOCAL_MACHINE_ID);
  assert.deepEqual(store.getDraft("s1"), draft("on local"));
});

test("moves drafts typed before the web user resolved under that user", () => {
  store.setDraft("s1", draft("typed before web-me answered"));
  store.markDraftSubmitted("s2", "pending before web-me answered");
  setCurrentMachineId("boxtwo");
  store.setDraft("s3", draft("typed on boxtwo"));
  setCurrentMachineId(LOCAL_MACHINE_ID);

  const scopeChanges = [];
  const unsubscribe = store.subscribeDraftScope(() => scopeChanges.push(store.getDraft("s1")?.value));
  store.setDraftUser("alice");

  assert.deepEqual(storage.keys().sort(), [
    "m:boxtwo:omp-web:draft:v1:alice:s3",
    keyOf("s1", "alice"),
    keyOf("s2", "alice"),
  ].sort());
  assert.equal(record("s2", "alice").status, "pending");
  assert.deepEqual(store.getDraft("s1"), draft("typed before web-me answered"));
  assert.deepEqual(scopeChanges, ["typed before web-me answered"], "listeners run after the move");

  store.setDraftUser("alice");
  assert.equal(scopeChanges.length, 1, "an unchanged user is not a scope change");
  unsubscribe();
  store.setDraftUser("alice");
});

test("a send still in flight stays pending and out of the composer when the web user resolves", () => {
  store.setDraft("new:/work", draft("first prompt"));
  store.markDraftSubmitted("new:/work", "first prompt");
  store.setDraftUser("alice");

  assert.equal(store.getDraft("new:/work"), null, "not re-read from disk as editable text");
  assert.equal(store.getDraftStatus("new:/work"), "pending");
  assert.equal(storage.getItem(keyOf("new:/work")), null);
  assert.equal(record("new:/work", "alice").status, "pending");
  assert.equal(record("new:/work", "alice").submittedText, "first prompt");

  // It then resolves exactly like a send that never saw the scope change.
  store.confirmDraft("new:/work", "first prompt");
  assert.equal(storage.getItem(keyOf("new:/work", "alice")), null);
});

test("a send rejected after the web user resolved restores its text once", () => {
  store.markDraftSubmitted("new:/work", "first prompt");
  store.setDraftUser("alice");

  assert.deepEqual(store.restoreDraftSubmission("new:/work", "first prompt"), draft("first prompt"));
  assert.deepEqual(store.getDraft("new:/work"), draft("first prompt"));
  assert.equal(store.getDraftStatus("new:/work"), "editing");
  assert.equal(record("new:/work", "alice").submittedText, undefined);
});

test("records an earlier page life left under the anonymous scope move as plain records", () => {
  storage.setItem(keyOf("s1"), JSON.stringify({ v: 1, text: "from last visit", status: "editing", updatedAt: 1 }));
  storage.setItem(keyOf("s2"), JSON.stringify({
    v: 1, text: "", status: "pending", submittedText: "unconfirmed", submittedAt: 2, updatedAt: 2,
  }));
  store.setDraftUser("alice");

  assert.deepEqual(storage.keys().sort(), [keyOf("s1", "alice"), keyOf("s2", "alice")].sort());
  assert.equal(record("s2", "alice").status, "pending", "still a record, not yet restored");
  assert.deepEqual(store.getDraft("s1"), draft("from last visit"));
  assert.deepEqual(store.getDraft("s2"), draft("unconfirmed"));
});

test("keeps different web users' drafts apart", () => {
  store.setDraftUser("alice");
  store.setDraft("s1", draft("alice's draft"));
  store.flushDrafts();

  store.setDraftUser("bob");
  assert.equal(store.getDraft("s1"), null);
  store.setDraft("s1", draft("bob's draft"));
  store.flushDrafts();

  assert.equal(record("s1", "alice").text, "alice's draft");
  assert.equal(record("s1", "bob").text, "bob's draft");
  store.setDraftUser("alice");
  assert.deepEqual(store.getDraft("s1"), draft("alice's draft"));

  // Signing out falls back to the anonymous scope without carrying anything over.
  store.setDraftUser(null);
  assert.equal(store.getDraft("s1"), null);
});

test("encodes the user segment so a name cannot reach another scope", () => {
  store.setDraftUser("a:b");
  store.setDraft("c", draft("x"));
  store.flushDrafts();

  assert.deepEqual(storage.keys(), ["omp-web:draft:v1:a%3Ab:c"]);
});

test("a user's existing draft and a pre-login one are both kept when scopes merge", () => {
  storage.setItem(keyOf("s1", "alice"), JSON.stringify({ v: 1, text: "from last visit", status: "editing", updatedAt: 1 }));
  store.setDraft("s1", draft("typed before login"));
  store.setDraftUser("alice");

  assert.deepEqual(store.getDraft("s1"), draft("from last visit\n\ntyped before login"));
  assert.equal(storage.getItem(keyOf("s1")), null);
});

test("reconcileHydratedDraftText keeps stored and typed text without repeating either", () => {
  const { reconcileHydratedDraftText } = store;

  assert.equal(reconcileHydratedDraftText("stored", ""), "stored");
  assert.equal(reconcileHydratedDraftText("", "typed"), "typed");
  assert.equal(reconcileHydratedDraftText("same", "same"), "same");
  assert.equal(reconcileHydratedDraftText("stored\n\ntyped", "typed"), "stored\n\ntyped");
  assert.equal(reconcileHydratedDraftText("stored", "stored plus more"), "stored plus more");
  assert.equal(reconcileHydratedDraftText("stored", "typed"), "stored\n\ntyped");
});

test("getDraft keeps returning independent copies", () => {
  store.setDraft("s1", draft("hello", [IMAGE]));

  const first = store.getDraft("s1");
  first.value = "mutated";
  first.images[0].data = "mutated";
  assert.deepEqual(store.getDraft("s1"), draft("hello", [IMAGE]));
});

// ── what the session hook does with a turn's outcome ───────────────────────
// Every prompt carries its own id and only an event naming it settles its submission.

test("a confirmed turn settles its own submission under the visible key and the session id", () => {
  const tracker = store.createSubmissionTracker();
  store.markDraftSubmitted("new:/work", "first prompt");
  tracker.track("new:/work", "first prompt", "p1");

  // Confirmed before the composer was rekeyed: the record is still under `new:`.
  tracker.confirm("session-1", "p1");
  assert.equal(storage.getItem(keyOf("new:/work")), null);

  // Confirmed after promotion moved the draft to the session id.
  store.markDraftSubmitted("new:/other", "second prompt");
  tracker.track("new:/other", "second prompt", "p2");
  store.rekeyDraft("new:/other", "session-2", empty());
  assert.equal(record("session-2").submittedText, "second prompt");
  tracker.confirm("session-2", "p2");
  assert.equal(storage.getItem(keyOf("session-2")), null);
  assert.equal(storage.keys().length, 0);
});

test("a stale or late prompt_done confirms only its own promptId", () => {
  const tracker = store.createSubmissionTracker();
  store.markDraftSubmitted("s1", "main prompt");
  store.markDraftSubmitted("s1", "/queued command");
  tracker.track("s1", "main prompt", "main");
  tracker.track("s1", "/queued command", "queued");

  // The queued prompt finishes while the main turn is still running.
  tracker.confirm("s1", "queued");
  assert.equal(record("s1").submittedText, "main prompt");
  assert.equal(store.getDraftStatus("s1"), "pending");

  // A late repeat, and an event for a turn this tracker never dispatched
  // (another tab's prompt, an earlier run's), change nothing...
  tracker.confirm("s1", "queued");
  tracker.confirm("s1", "someone-elses");
  assert.equal(record("s1").submittedText, "main prompt");
  assert.equal(store.getDraftStatus("s1"), "pending");

  // ...and the main turn's own event still settles it.
  tracker.confirm("s1", "main");
  assert.equal(store.getDraftStatus("s1"), null, "nothing left to keep");
  assert.equal(storage.getItem(keyOf("s1")), null);
});

test("identical texts under one key are settled one per promptId", () => {
  const tracker = store.createSubmissionTracker();
  store.markDraftSubmitted("s1", "continue");
  store.markDraftSubmitted("s1", "continue");
  tracker.track("s1", "continue", "p1");
  tracker.track("s1", "continue", "p2");

  tracker.confirm("s1", "p2");
  assert.equal(record("s1").submittedText, "continue");
  tracker.confirm("s1", "p2");
  assert.equal(record("s1").submittedText, "continue", "a repeated id settles nothing more");
  tracker.confirm("s1", "p1");
  assert.equal(storage.getItem(keyOf("s1")), null);
});

test("a queued prompt's error restores only that prompt and leaves the main confirmation alone", () => {
  const tracker = store.createSubmissionTracker();
  store.markDraftSubmitted("s1", "main prompt");
  store.markDraftSubmitted("s1", "/review");
  tracker.track("s1", "main prompt", "main");
  tracker.track("s1", "/review", "queued");

  // What the hook does with the queued prompt's prompt_error: take its own
  // submission and put its text back in the composer.
  const rejected = tracker.takeById("queued");
  assert.equal(rejected?.text, "/review");
  assert.deepEqual(store.restoreDraftSubmission("s1", rejected.text), draft("/review"));
  // Only the queued submission left the record; the main one is still pending,
  // and a replayed error has nothing left to take.
  assert.equal(record("s1").submittedText, "main prompt");
  assert.equal(store.getDraftStatus("s1"), "pending");
  assert.equal(tracker.takeById("queued"), null);

  // The main turn's confirmation is not blocked by the failed queued prompt and
  // does not swallow its restored text.
  tracker.confirm("s1", "main");
  assert.equal(store.getDraftStatus("s1"), "editing");
  assert.deepEqual(store.getDraft("s1"), draft("/review"));
});

test("takeById hands a submission back once, and only to the id that dispatched it", () => {
  const tracker = store.createSubmissionTracker();
  store.markDraftSubmitted("s1", "first");
  store.markDraftSubmitted("s1", "second");
  tracker.track("s1", "first", "p1");
  tracker.track("s1", "second", "p2");

  assert.equal(tracker.takeById("p3"), null);
  const taken = tracker.takeById("p2");
  assert.deepEqual({ ...taken }, { draftKey: "s1", text: "second", promptId: "p2" });
  assert.equal(tracker.takeById("p2"), null);

  // Taking only stops tracking: both submissions are still on record, and p1
  // is still its own to settle.
  assert.equal(record("s1").submittedText, "first\n\nsecond");
  tracker.confirm("s1", "p2");
  assert.equal(record("s1").submittedText, "first\n\nsecond");
  tracker.confirm("s1", "p1");
  assert.equal(record("s1").submittedText, "second");
});

test("an aborted prompt stays on record and its late prompt_done confirms nothing", () => {
  const tracker = store.createSubmissionTracker();
  store.markDraftSubmitted("s1", "prompt");
  store.markDraftSubmitted("s1", "/queued");
  tracker.track("s1", "prompt", "p1");
  tracker.track("s1", "/queued", "p2");

  // Abort: the in-flight submission leaves the tracker without being restored.
  assert.equal(tracker.takeById("p1")?.text, "prompt");
  tracker.confirm("s1", "p1");
  assert.equal(store.getDraftStatus("s1"), "pending");
  assert.equal(record("s1").submittedText, "prompt\n\n/queued");

  // The other prompt is unaffected and still settles on its own event.
  tracker.confirm("s1", "p2");
  assert.equal(record("s1").submittedText, "prompt");
  assert.equal(store.getDraftStatus("s1"), "pending");
});

test("an event without a promptId (an older remote) confirms and takes nothing", () => {
  const tracker = store.createSubmissionTracker();
  store.markDraftSubmitted("s1", "prompt");
  tracker.track("s1", "prompt", "p1");

  tracker.confirm("s1", undefined);
  tracker.confirm("s1", "");
  assert.equal(tracker.takeById(undefined), null);
  assert.equal(tracker.takeById(""), null);
  assert.equal(store.getDraftStatus("s1"), "pending");
  assert.equal(record("s1").submittedText, "prompt");

  // Nothing was consumed: the submission still settles on its own id.
  tracker.confirm("s1", "p1");
  assert.equal(store.getDraftStatus("s1"), null, "settled: nothing left to keep");
});

test("a later confirmed turn never settles a submission whose delivery is unknown", () => {
  const tracker = store.createSubmissionTracker();
  store.markDraftSubmitted("s1", "possibly undelivered");
  const ambiguous = tracker.track("s1", "possibly undelivered", "p1");
  tracker.untrack(ambiguous);

  store.markDraftSubmitted("s1", "second prompt");
  tracker.track("s1", "second prompt", "p2");
  tracker.confirm("s1", "p2");

  assert.equal(record("s1").submittedText, "possibly undelivered");
  assert.equal(store.getDraftStatus("s1"), "pending");
  // It is no longer tracked, so not even an event naming it settles it.
  tracker.confirm("s1", "p1");
  assert.equal(record("s1").submittedText, "possibly undelivered");
  // Restored, it comes back once and the record resolves.
  assert.deepEqual(store.restoreDraftSubmission("s1", "possibly undelivered"), draft("possibly undelivered"));
  assert.equal(store.getDraftStatus("s1"), "editing");
});

test("a rejected submission is untracked and its restored text is not confirmed away", () => {
  const tracker = store.createSubmissionTracker();
  store.markDraftSubmitted("s1", "/queued");
  const submission = tracker.track("s1", "/queued", "p1");

  tracker.untrack(submission);
  store.restoreDraftSubmission("s1", "/queued");
  tracker.confirm("s1", "p1");

  assert.deepEqual(store.getDraft("s1"), draft("/queued"));
  assert.equal(store.getDraftStatus("s1"), "editing");
});

test("the tracker ignores submissions with nothing durable and confirms each turn once", () => {
  const tracker = store.createSubmissionTracker();

  assert.equal(tracker.track(undefined, "no draft key", "p1"), null);
  assert.equal(tracker.track("s1", "  \n", "p2"), null, "image-only sends keep no text");
  assert.equal(tracker.track("s1", "no id", ""), null);
  assert.doesNotThrow(() => tracker.untrack(null));

  store.markDraftSubmitted("s1", "once");
  tracker.track("s1", "once", "p3");
  tracker.confirm("s1", "p3");
  store.markDraftSubmitted("s1", "once");
  tracker.confirm("s1", "p3");
  assert.equal(record("s1").submittedText, "once", "a second confirm has nothing tracked left to settle");
});

test("an acknowledged steer is settled under the draft key and the session id", () => {
  // A steer / follow-up has no turn event: the hook confirms it on its HTTP
  // response under both keys, because a first send may have promoted the
  // conversation (new:<cwd> -> session id) while the request was in flight.
  store.markDraftSubmitted("new:/work", "steer text");
  store.rekeyDraft("new:/work", "session-1", empty());

  store.confirmDraft("new:/work", "steer text");
  assert.equal(record("session-1").submittedText, "steer text", "nothing is left under the provisional key");
  store.confirmDraft("session-1", "steer text");
  assert.equal(storage.keys().length, 0);
});
