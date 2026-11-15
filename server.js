import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";

const PORT = Number(process.env.PORT || 4177);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "boards.json");
const PUBLIC_DIR = join(process.cwd(), "public");
const DEFAULT_PUBLISH_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

let db = { boards: {} };
let saveQueue = Promise.resolve();

async function loadDb() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) {
    await writeFile(DATA_FILE, JSON.stringify(db, null, 2));
    return;
  }
  try {
    db = JSON.parse(await readFile(DATA_FILE, "utf8"));
    if (!db.boards) db.boards = {};
  } catch {
    db = { boards: {} };
  }
  for (const board of Object.values(db.boards)) {
    if (!Array.isArray(board.bubbles)) {
      board.bubbles = Array.isArray(board.pages)
        ? board.pages.flatMap((page) => Array.isArray(page.bubbles) ? page.bubbles : [])
        : [];
    }
    if (!Object.hasOwn(board, "publishEndsAt")) {
      board.publishEndsAt = board.endsAt || null;
    }
    if (!Object.hasOwn(board, "publishEndedAt")) {
      board.publishEndedAt = board.endedAt || null;
    }
    board.publicToken ||= null;
    delete board.endsAt;
    delete board.endedAt;
    delete board.currentPageId;
    delete board.pages;
  }
  delete db.activeBoardId;
  await saveDb();
}

function saveDb() {
  saveQueue = saveQueue.then(() => writeFile(DATA_FILE, JSON.stringify(db, null, 2)));
  return saveQueue;
}

function updateScheduledPublishEnd(board) {
  if (!board || board.publishEndedAt || !board.publishEndsAt) return false;
  const endsAt = new Date(board.publishEndsAt).getTime();
  if (!Number.isFinite(endsAt) || Date.now() < endsAt) return false;
  board.publishEndedAt = new Date().toISOString();
  touch(board);
  return true;
}

async function updateAllScheduledPublishEnds() {
  let changed = false;
  for (const board of Object.values(db.boards)) {
    if (updateScheduledPublishEnd(board)) changed = true;
  }
  if (changed) await saveDb();
}

function normalizeEndsAt(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function svg(res, status, body) {
  res.writeHead(status, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function lanUrls() {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${PORT}/admin`);
      }
    }
  }
  return urls;
}

function unavailablePage(res) {
  res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>現在このページは公開されていません</title>
    <style>
      body {
        align-items: center;
        background: #eef3f6;
        color: #202124;
        display: flex;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
        text-align: center;
      }
      main {
        background: white;
        border: 1px solid #d9e0e7;
        border-radius: 8px;
        max-width: 560px;
        padding: 36px 28px;
        width: 100%;
      }
      h1 { font-size: 22px; margin: 0 0 12px; }
      p { color: #64707d; margin: 0; }
    </style>
  </head>
  <body>
    <main>
      <h1>現在このページは公開されていません</h1>
      <p>This page is currently unavailable.</p>
    </main>
  </body>
</html>`);
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicBoard(board, ownerKey = "") {
  updateScheduledPublishEnd(board);
  const isOwner = ownerKey === board.ownerKey;
  const result = {
    id: board.id,
    title: board.title,
    isOwner,
    isPublished: Boolean(board.publicToken && !board.publishEndedAt),
    publishEndsAt: board.publishEndsAt || null,
    publishEndedAt: board.publishEndedAt || null,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    bubbles: board.bubbles
  };
  if (isOwner) {
    result.ownerKey = board.ownerKey;
    result.publicToken = board.publicToken;
  }
  return result;
}

function createBoard(title, ownerName, publishEndsAt) {
  const now = new Date().toISOString();
  const board = {
    id: randomUUID().slice(0, 8),
    ownerKey: randomUUID(),
    title: title?.trim() || "今日のふきだし",
    publicToken: null,
    publishEndsAt: normalizeEndsAt(publishEndsAt),
    publishEndedAt: null,
    createdAt: now,
    updatedAt: now,
    bubbles: []
  };
  db.boards[board.id] = board;
  return board;
}

function touch(board) {
  board.updatedAt = new Date().toISOString();
}

function canEditBubble(board, bubble, user) {
  return user?.ownerKey === board.ownerKey || bubble.authorId === user?.userId;
}

function findBoardByPublicToken(token) {
  return Object.values(db.boards).find((board) => board.publicToken === token);
}

function isPubliclyAvailable(board) {
  updateScheduledPublishEnd(board);
  return Boolean(board?.publicToken && !board.publishEndedAt);
}

function publicParticipantBoard(board) {
  return {
    id: board.id,
    title: board.title,
    isOwner: false,
    isPublished: true,
    publishEndsAt: board.publishEndsAt || null,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    bubbles: board.bubbles
  };
}

async function handlePublicApi(req, res, pathname) {
  const match = pathname.match(/^\/api\/public\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return json(res, 404, { error: "not found" });

  const board = findBoardByPublicToken(match[1]);
  if (!board || !isPubliclyAvailable(board)) {
    await saveDb();
    return json(res, 404, { error: "not found" });
  }

  if (req.method === "GET" && !match[2]) {
    return json(res, 200, publicParticipantBoard(board));
  }

  const action = match[2];
  const body = await parseBody(req);
  const user = {
    userId: String(body.userId || ""),
    name: String(body.name || "匿名"),
    ownerKey: ""
  };

  if (req.method === "POST" && action === "bubbles") {
    const bubble = createBubble(body, user);
    if (!bubble.text) return json(res, 400, { error: "text required" });
    board.bubbles.push(bubble);
    touch(board);
    await saveDb();
    return json(res, 201, publicParticipantBoard(board));
  }

  if (req.method === "PATCH" && action === "bubbles") {
    const bubble = board.bubbles.find((item) => item.id === body.bubbleId);
    if (!bubble) return json(res, 404, { error: "bubble not found" });
    if (!canEditBubble(board, bubble, user)) return json(res, 403, { error: "locked" });
    updateBubble(bubble, body);
    touch(board);
    await saveDb();
    return json(res, 200, publicParticipantBoard(board));
  }

  if (req.method === "POST" && action === "like") {
    const bubble = board.bubbles.find((item) => item.id === body.bubbleId);
    if (!bubble) return json(res, 404, { error: "bubble not found" });
    toggleLike(bubble, user.userId);
    touch(board);
    await saveDb();
    return json(res, 200, publicParticipantBoard(board));
  }

  return json(res, 404, { error: "not found" });
}

function createBubble(body, user) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    text: String(body.text || "").trim().slice(0, 180),
    author: user.name.trim() || "匿名",
    authorId: user.userId,
    x: Math.max(0, Math.min(100, Number(body.x) || 20)),
    y: Math.max(0, Math.min(100, Number(body.y) || 20)),
    likes: [],
    createdAt: now,
    updatedAt: now
  };
}

function updateBubble(bubble, body) {
  if (typeof body.text === "string") bubble.text = body.text.trim().slice(0, 180) || bubble.text;
  if (body.x !== undefined) bubble.x = Math.max(0, Math.min(100, Number(body.x)));
  if (body.y !== undefined) bubble.y = Math.max(0, Math.min(100, Number(body.y)));
  bubble.updatedAt = new Date().toISOString();
}

function toggleLike(bubble, userId) {
  const i = bubble.likes.indexOf(userId);
  if (i >= 0) bubble.likes.splice(i, 1);
  else bubble.likes.push(userId);
}

async function handleApi(req, res, pathname) {
  if (pathname.startsWith("/api/public/")) {
    return handlePublicApi(req, res, pathname);
  }

  if (req.method === "POST" && pathname === "/api/publish") {
    const body = await parseBody(req);
    const board = db.boards[String(body.boardId || "")];
    if (!board) return json(res, 404, { error: "board not found" });
    if (String(body.ownerKey || "") !== board.ownerKey) {
      return json(res, 403, { error: "owner only" });
    }
    board.publishEndsAt = normalizeEndsAt(body.publishEndsAt)
      || board.publishEndsAt
      || new Date(Date.now() + DEFAULT_PUBLISH_DURATION_MS).toISOString();
    board.publicToken = randomUUID().replaceAll("-", "");
    board.publishEndedAt = null;
    touch(board);
    updateScheduledPublishEnd(board);
    await saveDb();
    return json(res, 200, publicBoard(board, board.ownerKey));
  }

  if (req.method === "GET" && pathname.startsWith("/api/qr/")) {
    const boardId = pathname.slice("/api/qr/".length);
    const board = db.boards[boardId];
    const ownerKey = String(req.headers["x-owner-key"] || "");
    if (!board || ownerKey !== board.ownerKey || !isPubliclyAvailable(board)) {
      return json(res, 404, { error: "not found" });
    }
    const origin = String(req.headers.origin || `http://${req.headers.host}`);
    const url = new URL(`/join/${board.publicToken}`, origin).toString();
    const image = await QRCode.toString(url, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      color: { dark: "#202124", light: "#ffffff" }
    });
    return svg(res, 200, image);
  }

  if (req.method === "GET" && pathname === "/api/server-info") {
    return json(res, 200, {
      host: HOST,
      port: PORT,
      adminUrls: lanUrls()
    });
  }

  if (req.method === "POST" && pathname === "/api/boards") {
    const body = await parseBody(req);
    const board = createBoard(body.title, body.ownerName, body.publishEndsAt);
    updateScheduledPublishEnd(board);
    await saveDb();
    return json(res, 201, publicBoard(board, board.ownerKey));
  }

  const match = pathname.match(/^\/api\/boards\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return json(res, 404, { error: "not found" });

  const board = db.boards[match[1]];
  if (!board) return json(res, 404, { error: "board not found" });

  if (req.method === "GET" && !match[2]) {
    const ownerKey = String(req.headers["x-owner-key"] || "");
    if (ownerKey !== board.ownerKey) return json(res, 404, { error: "not found" });
    if (updateScheduledPublishEnd(board)) await saveDb();
    return json(res, 200, publicBoard(board, ownerKey));
  }

  const action = match[2];
  const body = req.method === "GET" ? {} : await parseBody(req);
  const user = {
    userId: String(body.userId || ""),
    name: String(body.name || "匿名"),
    ownerKey: String(body.ownerKey || "")
  };

  if (req.method === "PATCH" && action === "event") {
    if (user.ownerKey !== board.ownerKey) return json(res, 403, { error: "owner only" });
    if (Object.hasOwn(body, "publishEndsAt")) {
      board.publishEndsAt = normalizeEndsAt(body.publishEndsAt);
    }
    if (body.endPublishNow === true) board.publishEndedAt = new Date().toISOString();
    touch(board);
    updateScheduledPublishEnd(board);
    await saveDb();
    return json(res, 200, publicBoard(board, user.ownerKey));
  }

  if (user.ownerKey !== board.ownerKey) return json(res, 404, { error: "not found" });

  if (req.method === "POST" && action === "bubbles") {
    const bubble = createBubble(body, user);
    if (!bubble.text) return json(res, 400, { error: "text required" });
    board.bubbles.push(bubble);
    touch(board);
    await saveDb();
    return json(res, 201, publicBoard(board, user.ownerKey));
  }

  if (req.method === "PATCH" && action === "bubbles") {
    const bubble = board.bubbles.find((item) => item.id === body.bubbleId);
    if (!bubble) return json(res, 404, { error: "bubble not found" });
    if (!canEditBubble(board, bubble, user)) return json(res, 403, { error: "locked" });
    updateBubble(bubble, body);
    touch(board);
    await saveDb();
    return json(res, 200, publicBoard(board, user.ownerKey));
  }

  if (req.method === "POST" && action === "like") {
    const bubble = board.bubbles.find((item) => item.id === body.bubbleId);
    if (!bubble) return json(res, 404, { error: "bubble not found" });
    toggleLike(bubble, user.userId);
    touch(board);
    await saveDb();
    return json(res, 200, publicBoard(board, user.ownerKey));
  }

  return json(res, 404, { error: "not found" });
}

function serveStatic(req, res, pathname) {
  const publicMatch = pathname.match(/^\/join\/([^/]+)$/);
  if (pathname.startsWith("/join")) {
    const board = publicMatch ? findBoardByPublicToken(publicMatch[1]) : null;
    if (!board || !isPubliclyAvailable(board)) {
      return unavailablePage(res);
    }
  }
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(PUBLIC_DIR, cleanPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    createReadStream(join(PUBLIC_DIR, "index.html")).pipe(res);
    return;
  }
  res.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] || "application/octet-stream"
  });
  createReadStream(filePath).pipe(res);
}

await loadDb();
setInterval(() => {
  updateAllScheduledPublishEnds().catch((error) => {
    console.error("failed to update scheduled publish endings", error);
  });
}, 15_000).unref();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}).listen(PORT, HOST, () => {
  const urls = lanUrls();
  console.log("Dojo Fukidashi server is running.");
  console.log(`Local admin: http://localhost:${PORT}/admin`);
  if (urls.length) {
    console.log("LAN admin URLs:");
    for (const url of urls) console.log(`  ${url}`);
  } else if (HOST !== "0.0.0.0") {
    console.log(`Admin URL: http://${HOST}:${PORT}/admin`);
  } else {
    console.log("No LAN IPv4 address was detected yet.");
  }
});
