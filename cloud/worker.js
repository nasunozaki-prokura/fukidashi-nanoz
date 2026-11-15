import { ASSETS } from "./assets.js";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const now = () => new Date().toISOString();
const token = () => crypto.randomUUID().replaceAll("-", "");
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const coordinate = value => Math.max(0, Math.min(100, Number(value) || 0));
const active = board => Boolean(board?.publicToken && !board.publishEndedAt && (!board.publishEndsAt || Date.parse(board.publishEndsAt) > Date.now()));
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

function view(board, ownerKey = "") {
  const owner = ownerKey === board.ownerKey;
  const result = { id: board.id, title: board.title, isOwner: owner, isPublished: active(board), publishEndsAt: board.publishEndsAt, publishEndedAt: board.publishEndedAt, createdAt: board.createdAt, updatedAt: board.updatedAt, bubbles: board.bubbles };
  if (owner) Object.assign(result, { ownerKey: board.ownerKey, publicToken: board.publicToken });
  return result;
}

async function read(db, field, value) {
  // field is chosen exclusively by the route handler.
  return db.prepare(`SELECT data, version FROM boards WHERE ${field} = ?`).bind(value).first();
}

async function change(db, id, mutate) {
  // Compare-and-swap prevents simultaneous participants overwriting each other.
  for (let attempt = 0; attempt < 12; attempt++) {
    const row = await read(db, "id", id);
    if (!row) fail(404, "board not found");
    const board = JSON.parse(row.data);
    mutate(board);
    board.updatedAt = now();
    const result = await db.prepare("UPDATE boards SET data = ?, public_token = ?, version = version + 1 WHERE id = ? AND version = ?").bind(JSON.stringify(board), board.publicToken, id, row.version).run();
    if (result.meta.changes === 1) return board;
  }
  fail(409, "混み合っています。もう一度投稿してください");
}

function sessionId(request) {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)dojo_session=([a-f0-9]{64})(?:;|$)/)?.[1] || "";
}

async function userIdFor(id) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function bodyOf(request) {
  if (Number(request.headers.get("content-length")) > 16384) fail(413, "request too large");
  const body = await request.text();
  if (body.length > 16384) fail(413, "request too large");
  try { const value = JSON.parse(body || "{}"); if (!value || Array.isArray(value) || typeof value !== "object") fail(400, "invalid body"); return value; }
  catch { fail(400, "invalid JSON"); }
}

async function api(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  if (path === "/api/session" && method === "GET") {
    const id = sessionId(request) || token() + token();
    return json({ userId: await userIdFor(id) }, 200, { "set-cookie": `dojo_session=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` });
  }
  if (!["GET", "HEAD"].includes(method)) {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) fail(403, "invalid origin");
    if (!request.headers.get("content-type")?.startsWith("application/json")) fail(415, "JSON required");
  }
  const body = method === "GET" ? {} : await bodyOf(request);
  const key = method === "GET" ? request.headers.get("x-owner-key") || "" : String(body.ownerKey || "");

  if (path === "/api/boards" && method === "POST") {
    const board = { id: crypto.randomUUID(), ownerKey: token() + token(), title: String(body.title || "今日のふきだし").trim().slice(0, 60), publicToken: null, publishEndsAt: date(body.publishEndsAt), publishEndedAt: null, createdAt: now(), updatedAt: now(), bubbles: [] };
    await env.DB.prepare("INSERT INTO boards (id, data) VALUES (?, ?)").bind(board.id, JSON.stringify(board)).run();
    return json(view(board, board.ownerKey), 201);
  }

  if (path === "/api/publish" && method === "POST") {
    const board = await change(env.DB, String(body.boardId || ""), b => {
      if (key !== b.ownerKey) fail(403, "owner only");
      b.publishEndsAt = date(body.publishEndsAt) || b.publishEndsAt || new Date(Date.now() + 30 * 86400000).toISOString();
      b.publicToken = token(); b.publishEndedAt = null;
    });
    return json(view(board, key));
  }

  const match = path.match(/^\/api\/(boards|public)\/([^/]+)(?:\/(bubbles|like|event))?$/);
  if (!match) fail(404, "not found");
  const participant = match[1] === "public";
  const row = await read(env.DB, participant ? "public_token" : "id", match[2]);
  if (!row) fail(404, "not found");
  let board = JSON.parse(row.data);
  const authorize = b => {
    if (participant) {
      if (b.publicToken !== match[2] || !active(b)) fail(404, "not found");
    } else if (key !== b.ownerKey) fail(404, "not found");
  };
  authorize(board);
  const action = match[3];
  if (method === "GET" && !action) return json(view(board, participant ? "" : key));
  if (!action) fail(405, "method not allowed");
  const session = sessionId(request);
  if (!session) fail(401, "ページを再読み込みしてください");
  const userId = await userIdFor(session);
  board = await change(env.DB, board.id, b => {
    authorize(b);
    if (action === "event" && method === "PATCH" && !participant) {
      if (Object.hasOwn(body, "publishEndsAt")) b.publishEndsAt = date(body.publishEndsAt);
      if (body.endPublishNow === true) b.publishEndedAt = now();
      return;
    }
    if (action === "bubbles" && method === "POST") {
      const text = String(body.text || "").trim().slice(0, 180);
      if (!text) fail(400, "text required");
      if (b.bubbles.length >= 1000) fail(400, "このボードは投稿上限に達しました");
      b.bubbles.push({ id: crypto.randomUUID(), text, author: String(body.name || "匿名").trim().slice(0, 24) || "匿名", authorId: userId, x: coordinate(body.x), y: coordinate(body.y), likes: [], createdAt: now(), updatedAt: now() });
      return;
    }
    const bubble = b.bubbles.find(item => item.id === body.bubbleId);
    if (!bubble) fail(404, "bubble not found");
    if (action === "bubbles" && method === "PATCH") {
      if (participant && bubble.authorId !== userId) fail(403, "locked");
      if (typeof body.text === "string") bubble.text = body.text.trim().slice(0, 180) || bubble.text;
      if (body.x !== undefined) bubble.x = coordinate(body.x);
      if (body.y !== undefined) bubble.y = coordinate(body.y);
      bubble.updatedAt = now();
      return;
    }
    if (action === "like" && method === "POST") {
      const i = bubble.likes.indexOf(userId);
      if (i < 0) bubble.likes.push(userId); else bubble.likes.splice(i, 1);
      return;
    }
    fail(405, "method not allowed");
  });
  return json(view(board, participant ? "" : key), method === "POST" && action === "bubbles" ? 201 : 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (request.method !== "GET" && request.method !== "HEAD") fail(405, "method not allowed");
      const join = url.pathname.match(/^\/join\/([^/]+)$/);
      if (join) {
        const row = await read(env.DB, "public_token", join[1]);
        if (!row || !active(JSON.parse(row.data))) return new Response('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公開されていません</title><h1>現在このページは公開されていません</h1></html>', { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      const asset = ASSETS[url.pathname === "/" || url.pathname === "/admin" || join ? "/index.html" : url.pathname];
      if (!asset) fail(404, "not found");
      return new Response(request.method === "HEAD" ? null : asset.text, { headers: { "content-type": asset.type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } });
    } catch (error) {
      if (!(error instanceof HttpError)) console.error("request failed", error);
      return json({ error: error instanceof HttpError ? error.message : "サーバーでエラーが発生しました" }, error.status || 500);
    }
  }
};
