import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { cacheSessionPath, invalidateSessionPathCache } from "../../../lib/session-reader.ts";
import { getRpcSession } from "../../../lib/rpc-manager.ts";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET } = await jiti.import("./[id]/route.ts");

test("session detail reads BTW sidecars without starting an agent and tolerates damaged history", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "btw-detail-")));
  const saved = Object.fromEntries(["OMP_WEB_PASSWORD", "OMP_WEB_USERS_FILE", "OMP_WEB_SESSIONS_FILE"].map((key) => [key, process.env[key]]));
  const previousRegistry = globalThis.__ompSessions;
  let id;
  try {
    delete process.env.OMP_WEB_PASSWORD;
    delete process.env.OMP_WEB_SESSIONS_FILE;
    process.env.OMP_WEB_USERS_FILE = join(directory, "absent-users.yml");
    globalThis.__ompWebUsersCache = undefined;
    globalThis.__ompSessions = new Map();
    const manager = SessionManager.create(directory, join(directory, "sessions"));
    await manager.ensureOnDisk();
    id = manager.getSessionId();
    cacheSessionPath(id, manager.getSessionFile());
    const store = await BtwHistoryStore.open(manager.getArtifactsDir());
    const record = { id: "saved-topic", title: "Terminal heading", question: "1+1=?", answer: "2", status: "complete", leafId: null, createdAt: 1, updatedAt: 2 };
    await store.upsert(record);
    const read = () => GET(new Request(`http://localhost/api/sessions/${id}`, { headers: { host: "localhost", "sec-fetch-site": "same-origin" } }), { params: Promise.resolve({ id }) });
    const response = await read();
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.deepEqual(detail.btwHistory, [{ id: record.id, question: record.question, answer: record.answer, status: record.status, leafId: null, createdAt: 1, updatedAt: 2 }]);
    assert.deepEqual(detail.context.messages, []);
    assert.equal(getRpcSession(id), undefined);
    assert.equal(globalThis.__ompSessions.size, 0);

    await writeFile(join(manager.getArtifactsDir(), "btw-history", "entry-saved-topic.json"), "{invalid");
    const damaged = await read();
    assert.equal(damaged.status, 200);
    assert.deepEqual((await damaged.json()).btwHistory, []);
    assert.equal(getRpcSession(id), undefined);
  } finally {
    if (id) invalidateSessionPathCache(id);
    globalThis.__ompSessions = previousRegistry;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.__ompWebUsersCache = undefined;
    await rm(directory, { recursive: true, force: true });
  }
});
