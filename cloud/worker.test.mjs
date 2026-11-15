import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import worker from "./worker.js";

test("shared cloud board: ownership, simultaneous posts, identity, rotation and expiry", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(await readFile(new URL("./drizzle/0000_boards.sql", import.meta.url), "utf8"));
  const env = { DB: { prepare(query) { return { bind(...values) { return {
    async first() { return sql.prepare(query).get(...values) || null; },
    async run() { return { meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; }
  }; } }; } } };
  const origin = "https://board.example";
  const request = async (path, method = "GET", body, cookie = "", key = "", extraHeaders = {}) => worker.fetch(new Request(origin + path, {
    method, headers: { "content-type": "application/json", "cookie": cookie, "x-owner-key": key, "origin": origin, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined
  }), env);
  const login = async () => {
    const r = await request("/api/session");
    return { ...await r.json(), cookie: r.headers.get("set-cookie").split(";")[0] };
  };
  try {
    const alice = await login(), bob = await login();
    const created = await request("/api/boards", "POST", { title: "Dojo" });
    assert.equal(created.status, 201);
    const board = await created.json();
    assert.equal((await request(`/api/boards/${board.id}`)).status, 404);
    assert.equal((await request("/api/publish", "POST", { boardId: board.id, ownerKey: "wrong" })).status, 403);
    const publish = async () => (await request("/api/publish", "POST", { boardId: board.id, ownerKey: board.ownerKey })).json();
    const published = await publish();
    const path = `/api/public/${published.publicToken}`;
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => request(path + "/bubbles", "POST", { text: `post ${i}`, name: "Alice", userId: bob.userId }, alice.cookie)));
    assert.ok(responses.every(r => r.status === 201));
    const shared = await (await request(path)).json();
    assert.equal(shared.bubbles.length, 8, "simultaneous posts must all survive");
    assert.equal(shared.bubbles[0].authorId, alice.userId, "ignore client-supplied identity");
    assert.equal(shared.ownerKey, undefined);
    assert.equal(shared.publicToken, undefined);
    const bubbleId = shared.bubbles[0].id;
    assert.equal((await request(path + "/bubbles", "PATCH", { bubbleId, text: "stolen", userId: alice.userId }, bob.cookie)).status, 403);
    assert.equal((await request(path + "/bubbles", "PATCH", { bubbleId, text: "stolen" }, `dojo_session=${alice.userId}`)).status, 403, "visible author IDs cannot be used as session credentials");
    assert.equal((await request(path + "/bubbles", "PATCH", { bubbleId, text: "edited" }, alice.cookie)).status, 200);
    assert.equal((await request(path + "/bubbles", "POST", { text: "cross origin" }, alice.cookie, "", { origin: "https://other.example" })).status, 403);
    await request(path + "/like", "POST", { bubbleId }, bob.cookie);
    assert.equal((await (await request(path)).json()).bubbles[0].likes.length, 1);
    const rotated = await publish();
    assert.equal((await request(path)).status, 404);
    const event = `/api/boards/${board.id}/event`;
    await request(event, "PATCH", { ownerKey: board.ownerKey, publishEndsAt: "2000-01-01T00:00:00Z" }, alice.cookie);
    assert.equal((await request(`/api/public/${rotated.publicToken}`)).status, 404);
    assert.equal((await request(`/api/boards/${board.id}`, "GET", undefined, "", board.ownerKey)).status, 200);
  } finally { sql.close(); }
});
