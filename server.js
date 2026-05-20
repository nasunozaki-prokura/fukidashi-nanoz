import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4177);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "boards.json");
const PUBLIC_DIR = join(process.cwd(), "public");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
  cleanupExpiredBoards();
  await saveDb();
}

function saveDb() {
  saveQueue = saveQueue.then(() => writeFile(DATA_FILE, JSON.stringify(db, null, 2)));
  return saveQueue;
}

function cleanupExpiredBoards() {
  const now = Date.now();
  for (const [id, board] of Object.entries(db.boards)) {
    if (now - new Date(board.createdAt).getTime() > RETENTION_MS) {
      delete db.boards[id];
    }
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicBoard(board, ownerKey = "") {
  const isOwner = ownerKey === board.ownerKey;
  const result = {
    id: board.id,
    title: board.title,
    isOwner,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    currentPageId: board.currentPageId,
    pages: board.pages
  };
  if (isOwner) result.ownerKey = board.ownerKey;
  return result;
}

function createBoard(title, ownerName) {
  const pageId = randomUUID();
  const now = new Date().toISOString();
  const board = {
    id: randomUUID().slice(0, 8),
    ownerKey: randomUUID(),
    title: title?.trim() || "今日のふきだし",
    createdAt: now,
    updatedAt: now,
    currentPageId: pageId,
    pages: [
      {
        id: pageId,
        title: "ページ 1",
        lockEdits: true,
        hideOthers: false,
        bubbles: [
          {
            id: randomUUID(),
            text: "ここに意見を書いて共有できます",
            author: ownerName?.trim() || "講師",
            x: 36,
            y: 38,
            likes: [],
            createdAt: now,
            updatedAt: now
          }
        ]
      }
    ]
  };
  db.boards[board.id] = board;
  return board;
}

function touch(board) {
  board.updatedAt = new Date().toISOString();
}

function findPage(board, pageId) {
  return board.pages.find((page) => page.id === pageId) || board.pages[0];
}

function canEditBubble(board, page, bubble, user) {
  return user?.ownerKey === board.ownerKey || !page.lockEdits || bubble.authorId === user?.userId;
}

async function handleApi(req, res, pathname) {
  cleanupExpiredBoards();

  if (req.method === "POST" && pathname === "/api/boards") {
    const body = await parseBody(req);
    const board = createBoard(body.title, body.ownerName);
    await saveDb();
    return json(res, 201, publicBoard(board, board.ownerKey));
  }

  const match = pathname.match(/^\/api\/boards\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return json(res, 404, { error: "not found" });

  const board = db.boards[match[1]];
  if (!board) return json(res, 404, { error: "board not found" });

  if (req.method === "GET" && !match[2]) {
    return json(res, 200, publicBoard(board, String(req.headers["x-owner-key"] || "")));
  }

  const action = match[2];
  const body = req.method === "GET" ? {} : await parseBody(req);
  const user = {
    userId: String(body.userId || ""),
    name: String(body.name || "匿名"),
    ownerKey: String(body.ownerKey || "")
  };

  if (req.method === "POST" && action === "pages") {
    if (user.ownerKey !== board.ownerKey) return json(res, 403, { error: "owner only" });
    const page = {
      id: randomUUID(),
      title: body.title?.trim() || `ページ ${board.pages.length + 1}`,
      lockEdits: true,
      hideOthers: false,
      bubbles: []
    };
    board.pages.push(page);
    board.currentPageId = page.id;
    touch(board);
    await saveDb();
    return json(res, 201, publicBoard(board, user.ownerKey));
  }

  if (req.method === "PATCH" && action === "page") {
    if (user.ownerKey !== board.ownerKey) return json(res, 403, { error: "owner only" });
    const page = findPage(board, body.pageId);
    if (typeof body.title === "string") page.title = body.title.trim() || page.title;
    if (typeof body.lockEdits === "boolean") page.lockEdits = body.lockEdits;
    if (typeof body.hideOthers === "boolean") page.hideOthers = body.hideOthers;
    if (body.current === true) board.currentPageId = page.id;
    touch(board);
    await saveDb();
    return json(res, 200, publicBoard(board, user.ownerKey));
  }

  if (req.method === "POST" && action === "bubbles") {
    const page = findPage(board, body.pageId);
    const bubble = {
      id: randomUUID(),
      text: String(body.text || "").trim().slice(0, 180),
      author: user.name.trim() || "匿名",
      authorId: user.userId,
      x: Math.max(2, Math.min(82, Number(body.x) || 20)),
      y: Math.max(5, Math.min(82, Number(body.y) || 20)),
      likes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!bubble.text) return json(res, 400, { error: "text required" });
    page.bubbles.push(bubble);
    touch(board);
    await saveDb();
    return json(res, 201, publicBoard(board, user.ownerKey));
  }

  if (req.method === "PATCH" && action === "bubbles") {
    const page = findPage(board, body.pageId);
    const bubble = page.bubbles.find((item) => item.id === body.bubbleId);
    if (!bubble) return json(res, 404, { error: "bubble not found" });
    if (!canEditBubble(board, page, bubble, user)) return json(res, 403, { error: "locked" });
    if (typeof body.text === "string") bubble.text = body.text.trim().slice(0, 180) || bubble.text;
    if (body.x !== undefined) bubble.x = Math.max(2, Math.min(82, Number(body.x)));
    if (body.y !== undefined) bubble.y = Math.max(5, Math.min(82, Number(body.y)));
    bubble.updatedAt = new Date().toISOString();
    touch(board);
    await saveDb();
    return json(res, 200, publicBoard(board, user.ownerKey));
  }

  if (req.method === "POST" && action === "like") {
    const page = findPage(board, body.pageId);
    const bubble = page.bubbles.find((item) => item.id === body.bubbleId);
    if (!bubble) return json(res, 404, { error: "bubble not found" });
    const i = bubble.likes.indexOf(user.userId);
    if (i >= 0) bubble.likes.splice(i, 1);
    else bubble.likes.push(user.userId);
    touch(board);
    await saveDb();
    return json(res, 200, publicBoard(board, user.ownerKey));
  }

  return json(res, 404, { error: "not found" });
}

function serveStatic(req, res, pathname) {
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
  console.log(`myfukidashi is running at http://${HOST}:${PORT}`);
});
