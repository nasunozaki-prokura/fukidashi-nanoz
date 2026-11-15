const isAdminMode = location.pathname === "/admin" || location.pathname === "/";
const publicToken = isAdminMode ? "" : location.pathname.match(/^\/join\/([^/]+)$/)?.[1] || "";
const DEFAULT_PUBLISH_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const ownerKeys = JSON.parse(localStorage.getItem("myfukidashi:ownerKeys") || "{}");
const initialUrlBoardId = new URL(location.href).searchParams.get("b");
const legacyOwnerKey = localStorage.getItem("myfukidashi:ownerKey");

function createClientId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

if (initialUrlBoardId && legacyOwnerKey && !ownerKeys[initialUrlBoardId]) {
  ownerKeys[initialUrlBoardId] = legacyOwnerKey;
  localStorage.setItem("myfukidashi:ownerKeys", JSON.stringify(ownerKeys));
}

const state = {
  board: null,
  userId: localStorage.getItem("myfukidashi:userId") || createClientId(),
  name: localStorage.getItem("myfukidashi:name") || "",
  pollTimer: null,
  drag: null,
  qrObjectUrl: "",
  endsAtDirty: false
};

localStorage.setItem("myfukidashi:userId", state.userId);

const $ = (selector) => document.querySelector(selector);
const welcome = $("#welcome");
const boardView = $("#boardView");
const createForm = $("#createForm");
const canvas = $("#canvas");
const bubbleForm = $("#bubbleForm");
const bubbleInput = bubbleForm.querySelector("input");
const bubbleSubmitButton = bubbleForm.querySelector("button");
const nameInput = $("#nameInput");
const ownerTools = $("#ownerTools");
const publishPanel = $("#publishPanel");
const publishStatus = $("#publishStatus");
const copyLinkButton = $("#copyLinkButton");
const publishButton = $("#publishButton");
const qrPanel = $("#qrPanel");
const qrCode = $("#qrCode");
const newBoardButton = $("#newBoardButton");
const displayModeButton = $("#displayModeButton");
const recentBoards = $("#recentBoards");
const recentBoardList = $("#recentBoardList");
const endsAtInput = $("#endsAtInput");
const saveEndsAtButton = $("#saveEndsAtButton");
const endEventButton = $("#endEventButton");

nameInput.value = state.name;

function boardIdFromUrl() {
  return new URL(location.href).searchParams.get("b");
}

function ownerKeyFor(boardId = state.board?.id) {
  return isAdminMode && boardId ? String(ownerKeys[boardId] || "") : "";
}

function rememberOwner(board) {
  if (!board?.ownerKey) return;
  ownerKeys[board.id] = board.ownerKey;
  localStorage.setItem("myfukidashi:ownerKeys", JSON.stringify(ownerKeys));
}

function setBoardUrl(board) {
  if (!isAdminMode) return;
  const url = new URL("/admin", location.origin);
  url.searchParams.set("b", board.id);
  history.replaceState(null, "", url);
}

function studentUrl() {
  if (!state.board?.publicToken) return "";
  return new URL(`/join/${state.board.publicToken}`, location.origin).toString();
}

function isOwner() {
  return Boolean(state.board?.isOwner);
}

async function api(path, options = {}) {
  const { ownerKey = ownerKeyFor(), ...fetchOptions } = options;
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      "x-owner-key": ownerKey
    },
    ...fetchOptions,
    body: fetchOptions.body ? JSON.stringify(fetchOptions.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "request failed");
  return data;
}

async function fetchWithOwner(path, options = {}) {
  const { ownerKey = ownerKeyFor(), ...fetchOptions } = options;
  return fetch(path, {
    headers: {
      "x-owner-key": ownerKey
    },
    ...fetchOptions
  });
}

function setStatus(text) {
  $("#status").textContent = text;
}

function updateTopActions() {
  displayModeButton.hidden = !isAdminMode || !state.board?.isPublished;
  if (displayModeButton.hidden) document.body.classList.remove("display-mode");
  publishPanel.hidden = !isAdminMode || !isOwner();
  publishStatus.textContent = state.board?.isPublished ? "公開中" : "非公開";
  publishStatus.classList.toggle("published", Boolean(state.board?.isPublished));
  copyLinkButton.hidden = !isAdminMode || !state.board?.isPublished;
  publishButton.hidden = !isAdminMode || !isOwner() || state.board?.isPublished;
  qrPanel.hidden = !isAdminMode || !state.board?.isPublished;
  if (isAdminMode && state.board?.isPublished) {
    loadQrCode();
  } else {
    if (state.qrObjectUrl) URL.revokeObjectURL(state.qrObjectUrl);
    state.qrObjectUrl = "";
    qrCode.removeAttribute("src");
    delete qrCode.dataset.publicToken;
  }
  newBoardButton.hidden = !isAdminMode || !state.board;
}

displayModeButton.addEventListener("click", () => {
  const enabled = document.body.classList.toggle("display-mode");
  displayModeButton.textContent = enabled ? "通常表示に戻る" : "会場表示";
  displayModeButton.setAttribute("aria-pressed", String(enabled));
});

async function loadQrCode() {
  if (!state.board?.isPublished || qrCode.dataset.publicToken === state.board.publicToken) return;
  try {
    if (state.qrObjectUrl) URL.revokeObjectURL(state.qrObjectUrl);
    qrCode.src = await QRCode.toDataURL(studentUrl(), {
      width: 840,
      margin: 3,
      errorCorrectionLevel: "M",
      color: { dark: "#202124", light: "#ffffff" }
    });
    qrCode.dataset.publicToken = state.board.publicToken;
  } catch {
    setStatus("QRコードを生成できません");
  }
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function dateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function isoFromLocalValue(value) {
  return value ? new Date(value).toISOString() : null;
}

function defaultPublishEndsAt() {
  return new Date(Date.now() + DEFAULT_PUBLISH_DURATION_MS).toISOString();
}

function showNotFound() {
  document.title = "現在このページは公開されていません";
  const main = document.createElement("main");
  main.className = "unavailable";
  const title = document.createElement("h1");
  title.textContent = "現在このページは公開されていません";
  const message = document.createElement("p");
  message.textContent = "This page is currently unavailable.";
  main.append(title, message);
  document.body.replaceChildren(main);
}

function render() {
  if (!state.board) return;
  welcome.hidden = true;
  boardView.hidden = false;
  updateTopActions();
  $("#boardTitle").textContent = state.board.title;
  $("#retentionNote").textContent = state.board.isPublished ? "公開中" : "非公開";
  ownerTools.hidden = !isOwner();
  if (!state.endsAtDirty) {
    endsAtInput.value = dateTimeLocalValue(state.board.publishEndsAt);
  }
  endEventButton.disabled = !state.board.isPublished;
  endEventButton.hidden = !state.board.isPublished;
  bubbleInput.disabled = false;
  bubbleSubmitButton.disabled = false;
  bubbleInput.placeholder = "ふきだしを書く";

  canvas.replaceChildren(...state.board.bubbles.map((bubble) => renderBubble(bubble)));
}

function renderBubble(bubble) {
  const node = $("#bubbleTemplate").content.firstElementChild.cloneNode(true);
  node.dataset.id = bubble.id;
  node.style.left = `${bubble.x}%`;
  node.style.top = `${bubble.y}%`;
  node.classList.toggle("mine", bubble.authorId === state.userId);
  node.querySelector("p").textContent = bubble.text;
  node.querySelector("strong").textContent = bubble.author || "匿名";
  const time = node.querySelector("time");
  time.dateTime = bubble.createdAt || "";
  time.textContent = formatDateTime(bubble.createdAt);
  const like = node.querySelector("button");
  like.textContent = `いいね ${bubble.likes.length}`;
  like.addEventListener("click", (event) => {
    event.stopPropagation();
    likeBubble(bubble.id);
  });
  node.addEventListener("dblclick", () => editBubble(bubble));
  node.addEventListener("pointerdown", (event) => startDrag(event, node, bubble));
  return node;
}

function useBoard(board) {
  if (state.board?.id !== board.id) {
    state.endsAtDirty = false;
    if (isAdminMode && !board.publishEndsAt) {
      board.publishEndsAt = defaultPublishEndsAt();
      state.endsAtDirty = true;
    }
  }
  state.board = board;
  render();
}

async function loadBoard(id) {
  const board = await api(`/api/boards/${id}`, { ownerKey: ownerKeyFor(id) });
  useBoard(board);
  setBoardUrl(board);
  setStatus(board.isPublished ? "公開中" : "非公開");
  startPolling(refreshBoard);
}

async function loadPublicBoard() {
  if (!publicToken) return showNotFound();
  useBoard(await api(`/api/public/${publicToken}`));
  setStatus("公開中・自動更新");
}

function startPolling(callback) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(callback, 1200);
}

async function refreshBoard() {
  if (!state.board || state.drag) return;
  try {
    const path = isAdminMode
      ? `/api/boards/${state.board.id}`
      : `/api/public/${publicToken}`;
    useBoard(await api(path));
  } catch {
    if (!isAdminMode) return showNotFound();
    setStatus("ボードを読み込めません");
  }
}

function userBody(extra = {}) {
  return {
    userId: state.userId,
    name: state.name || "匿名",
    ownerKey: ownerKeyFor(),
    ...extra
  };
}

async function addBubble(text) {
  const x = 12 + Math.random() * 54;
  const y = 12 + Math.random() * 48;
  const path = isAdminMode
    ? `/api/boards/${state.board.id}/bubbles`
    : `/api/public/${publicToken}/bubbles`;
  state.board = await api(path, {
    method: "POST",
    body: userBody({ text, x, y })
  });
  render();
}

async function likeBubble(bubbleId) {
  const path = isAdminMode
    ? `/api/boards/${state.board.id}/like`
    : `/api/public/${publicToken}/like`;
  state.board = await api(path, {
    method: "POST",
    body: userBody({ bubbleId })
  });
  render();
}

async function editBubble(bubble) {
  const allowed = isOwner() || bubble.authorId === state.userId;
  if (!allowed) return;
  const text = prompt("ふきだしを編集", bubble.text);
  if (!text) return;
  const path = isAdminMode
    ? `/api/boards/${state.board.id}/bubbles`
    : `/api/public/${publicToken}/bubbles`;
  state.board = await api(path, {
    method: "PATCH",
    body: userBody({ bubbleId: bubble.id, text })
  });
  render();
}

function startDrag(event, node, bubble) {
  const allowed = isOwner() || bubble.authorId === state.userId;
  if (!allowed) return;
  event.preventDefault();
  node.setPointerCapture(event.pointerId);
  const rect = canvas.getBoundingClientRect();
  state.drag = {
    node,
    bubbleId: bubble.id,
    pointerId: event.pointerId,
    offsetX: event.clientX - node.getBoundingClientRect().left,
    offsetY: event.clientY - node.getBoundingClientRect().top,
    rect,
    maxX: Math.max(0, rect.width - node.offsetWidth),
    maxY: Math.max(0, rect.height - node.offsetHeight)
  };
  node.classList.add("dragging");
}

canvas.addEventListener("pointermove", (event) => {
  if (!state.drag) return;
  const left = Math.max(0, Math.min(
    state.drag.maxX,
    event.clientX - state.drag.rect.left - state.drag.offsetX
  ));
  const top = Math.max(0, Math.min(
    state.drag.maxY,
    event.clientY - state.drag.rect.top - state.drag.offsetY
  ));
  state.drag.node.style.left = `${(left / state.drag.rect.width) * 100}%`;
  state.drag.node.style.top = `${(top / state.drag.rect.height) * 100}%`;
});

canvas.addEventListener("pointerup", async (event) => {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  const x = Number.parseFloat(state.drag.node.style.left);
  const y = Number.parseFloat(state.drag.node.style.top);
  const drag = state.drag;
  state.drag = null;
  drag.node.classList.remove("dragging");
  const path = isAdminMode
    ? `/api/boards/${state.board.id}/bubbles`
    : `/api/public/${publicToken}/bubbles`;
  state.board = await api(path, {
    method: "PATCH",
    body: userBody({ bubbleId: drag.bubbleId, x, y })
  });
  render();
});

canvas.addEventListener("pointercancel", () => {
  if (!state.drag) return;
  state.drag.node.classList.remove("dragging");
  state.drag = null;
  render();
});

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(createForm);
  state.name = String(form.get("ownerName") || "").trim();
  localStorage.setItem("myfukidashi:name", state.name);
  nameInput.value = state.name;
  const board = await api("/api/boards", {
    method: "POST",
    body: {
      title: form.get("title"),
      ownerName: state.name,
      publishEndsAt: isoFromLocalValue(String(form.get("publishEndsAt") || ""))
    }
  });
  rememberOwner(board);
  useBoard(board);
  setBoardUrl(board);
  setStatus("作成しました。公開すると参加URLが生成されます");
  startPolling(refreshBoard);
});

bubbleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.name) {
    setStatus("表示名を入力してください");
    nameInput.focus();
    return;
  }
  const text = String(new FormData(bubbleForm).get("text") || "").trim();
  if (!text) return;
  bubbleForm.reset();
  await addBubble(text);
});

nameInput.addEventListener("input", () => {
  state.name = nameInput.value.trim();
  localStorage.setItem("myfukidashi:name", state.name);
});

endsAtInput.addEventListener("input", () => {
  state.endsAtDirty = true;
  setStatus("公開終了日時は未保存です");
});

copyLinkButton.addEventListener("click", async () => {
  const url = studentUrl();
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(url);
    setStatus("生徒用URLをコピーしました");
  } catch {
    prompt("生徒用URLをコピーしてください", url);
  }
});

publishButton.addEventListener("click", async () => {
  const publishEndsAt = isoFromLocalValue(endsAtInput.value) || defaultPublishEndsAt();
  state.board = await api("/api/publish", {
    method: "POST",
    body: userBody({ boardId: state.board.id, publishEndsAt })
  });
  state.endsAtDirty = false;
  setStatus("公開URLを生成しました");
  render();
});

saveEndsAtButton.addEventListener("click", async () => {
  const value = endsAtInput.value;
  saveEndsAtButton.disabled = true;
  try {
    state.board = await api(`/api/boards/${state.board.id}/event`, {
      method: "PATCH",
      body: userBody({ publishEndsAt: isoFromLocalValue(value) })
    });
    state.endsAtDirty = false;
    setStatus(state.board.publishEndsAt ? "公開終了日時を保存しました" : "公開終了日時を解除しました");
    render();
  } catch {
    setStatus("公開終了日時を保存できませんでした");
  } finally {
    saveEndsAtButton.disabled = false;
  }
});

endEventButton.addEventListener("click", async () => {
  if (!confirm(`「${state.board.title}」の公開を終了しますか？ 公開URLはNot Foundになります。`)) return;
  state.board = await api(`/api/boards/${state.board.id}/event`, {
    method: "PATCH",
    body: userBody({ endPublishNow: true })
  });
  setStatus("公開を終了しました");
  render();
});

newBoardButton.addEventListener("click", () => {
  location.href = "/admin";
});

async function renderKnownBoards() {
  const boards = (await Promise.all(Object.keys(ownerKeys).map(async (id) => {
    try {
      return await api(`/api/boards/${id}`, { ownerKey: ownerKeyFor(id) });
    } catch {
      return null;
    }
  }))).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  recentBoards.hidden = boards.length === 0;
  recentBoardList.replaceChildren(...boards.map((board) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-board";
    const title = document.createElement("strong");
    title.textContent = board.title;
    const detail = document.createElement("span");
    detail.textContent = board.isPublished ? "公開中" : "非公開";
    button.append(title, detail);
    button.addEventListener("click", () => {
      location.href = `/admin?b=${encodeURIComponent(board.id)}`;
    });
    return button;
  }));
}

async function initialize() {
  if (document.querySelector('meta[name="cloud-app"]')) {
    try {
      const session = await api("/api/session", { ownerKey: "" });
      state.userId = session.userId;
    } catch {
      setStatus("接続できません。ページを再読み込みしてください");
      return;
    }
  }
  if (!isAdminMode) {
    $(".identity h3").textContent = "あなたの表示名";
    welcome.hidden = true;
    try {
      await loadPublicBoard();
      startPolling(refreshBoard);
    } catch {
      showNotFound();
    }
    return;
  }

  const initialBoard = boardIdFromUrl();
  if (!initialBoard) {
    setStatus("管理者ページ");
    updateTopActions();
    await renderKnownBoards();
    return;
  }

  welcome.hidden = true;
  setStatus("ボードを読み込み中");
  try {
    await loadBoard(initialBoard);
  } catch {
    setStatus("ボードが見つかりません");
    welcome.hidden = false;
  }
}

initialize();
