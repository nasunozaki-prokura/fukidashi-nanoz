const state = {
  board: null,
  currentPageId: null,
  userId: localStorage.getItem("myfukidashi:userId") || crypto.randomUUID(),
  name: localStorage.getItem("myfukidashi:name") || "",
  ownerKey: localStorage.getItem("myfukidashi:ownerKey") || "",
  pollTimer: null,
  drag: null
};

localStorage.setItem("myfukidashi:userId", state.userId);

const $ = (selector) => document.querySelector(selector);
const welcome = $("#welcome");
const boardView = $("#boardView");
const createForm = $("#createForm");
const canvas = $("#canvas");
const bubbleForm = $("#bubbleForm");
const pageList = $("#pageList");
const nameInput = $("#nameInput");
const ownerTools = $("#ownerTools");
const lockToggle = $("#lockToggle");
const hideToggle = $("#hideToggle");
const addPageButton = $("#addPageButton");
const gatherButton = $("#gatherButton");
const copyLinkButton = $("#copyLinkButton");
const newBoardButton = $("#newBoardButton");

nameInput.value = state.name;

function boardIdFromUrl() {
  const url = new URL(location.href);
  return url.searchParams.get("b");
}

function setBoardUrl(board) {
  const url = new URL(location.href);
  url.searchParams.set("b", board.id);
  history.replaceState(null, "", url);
}

function shareUrl() {
  if (!state.board) return location.href;
  const url = new URL(location.href);
  url.searchParams.set("b", state.board.id);
  return url.toString();
}

function isOwner() {
  return Boolean(state.board?.isOwner);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      "x-owner-key": state.ownerKey
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "request failed");
  return data;
}

function activePage() {
  if (!state.board) return null;
  return state.board.pages.find((page) => page.id === state.currentPageId) || state.board.pages[0];
}

function setStatus(text) {
  $("#status").textContent = text;
}

function daysLeft(createdAt) {
  const elapsed = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.ceil((30 * 24 * 60 * 60 * 1000 - elapsed) / (24 * 60 * 60 * 1000)));
}

function render() {
  if (!state.board) return;
  const page = activePage();
  welcome.hidden = true;
  boardView.hidden = false;
  $("#boardTitle").textContent = `${state.board.title} / ${page.title}`;
  $("#retentionNote").textContent = `あと約${daysLeft(state.board.createdAt)}日保持`;
  ownerTools.hidden = !isOwner();
  addPageButton.disabled = !isOwner();
  lockToggle.checked = page.lockEdits;
  hideToggle.checked = page.hideOthers;

  pageList.replaceChildren(...state.board.pages.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `page-item${item.id === page.id ? " active" : ""}`;
    button.textContent = item.title;
    button.addEventListener("click", () => selectPage(item.id));
    return button;
  }));

  canvas.replaceChildren(...page.bubbles.map((bubble) => renderBubble(page, bubble)));
}

function renderBubble(page, bubble) {
  const node = $("#bubbleTemplate").content.firstElementChild.cloneNode(true);
  node.dataset.id = bubble.id;
  node.style.left = `${bubble.x}%`;
  node.style.top = `${bubble.y}%`;
  node.classList.toggle("mine", bubble.authorId === state.userId);
  node.classList.toggle("hidden-bubble", page.hideOthers && !isOwner() && bubble.authorId !== state.userId);
  node.querySelector("p").textContent = page.hideOthers && !isOwner() && bubble.authorId !== state.userId ? "非表示" : bubble.text;
  node.querySelector("span").textContent = bubble.author || "匿名";
  const like = node.querySelector("button");
  like.textContent = `いいね ${bubble.likes.length}`;
  like.addEventListener("click", (event) => {
    event.stopPropagation();
    likeBubble(page.id, bubble.id);
  });
  node.addEventListener("dblclick", () => editBubble(page, bubble));
  node.addEventListener("pointerdown", (event) => startDrag(event, node, page, bubble));
  return node;
}

async function loadBoard(id) {
  state.board = await api(`/api/boards/${id}`);
  state.currentPageId = state.board.currentPageId;
  setBoardUrl(state.board);
  setStatus("接続中");
  render();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshBoard, 1600);
}

async function refreshBoard() {
  if (!state.board) return;
  try {
    const board = await api(`/api/boards/${state.board.id}`);
    state.board = board;
    if (!board.pages.some((page) => page.id === state.currentPageId)) {
      state.currentPageId = board.currentPageId;
    }
    render();
  } catch {
    setStatus("ボードを読み込めません");
  }
}

async function selectPage(pageId) {
  state.currentPageId = pageId;
  render();
  if (isOwner()) {
    state.board = await api(`/api/boards/${state.board.id}/page`, {
      method: "PATCH",
      body: userBody({ pageId, current: true })
    });
  }
}

function userBody(extra = {}) {
  return {
    userId: state.userId,
    name: state.name || "匿名",
    ownerKey: state.ownerKey,
    ...extra
  };
}

async function addBubble(text) {
  const rect = canvas.getBoundingClientRect();
  const x = 12 + Math.random() * 54;
  const y = 12 + Math.random() * 48;
  state.board = await api(`/api/boards/${state.board.id}/bubbles`, {
    method: "POST",
    body: userBody({ pageId: activePage().id, text, x, y, width: rect.width })
  });
  render();
}

async function likeBubble(pageId, bubbleId) {
  state.board = await api(`/api/boards/${state.board.id}/like`, {
    method: "POST",
    body: userBody({ pageId, bubbleId })
  });
  render();
}

async function editBubble(page, bubble) {
  const allowed = isOwner() || !page.lockEdits || bubble.authorId === state.userId;
  if (!allowed) return;
  const text = prompt("ふきだしを編集", bubble.text);
  if (!text) return;
  state.board = await api(`/api/boards/${state.board.id}/bubbles`, {
    method: "PATCH",
    body: userBody({ pageId: page.id, bubbleId: bubble.id, text })
  });
  render();
}

function startDrag(event, node, page, bubble) {
  const allowed = isOwner() || !page.lockEdits || bubble.authorId === state.userId;
  if (!allowed) return;
  event.preventDefault();
  node.setPointerCapture(event.pointerId);
  const rect = canvas.getBoundingClientRect();
  state.drag = {
    node,
    pageId: page.id,
    bubbleId: bubble.id,
    pointerId: event.pointerId,
    offsetX: event.clientX - node.getBoundingClientRect().left,
    offsetY: event.clientY - node.getBoundingClientRect().top,
    rect
  };
}

canvas.addEventListener("pointermove", (event) => {
  if (!state.drag) return;
  const x = ((event.clientX - state.drag.rect.left - state.drag.offsetX) / state.drag.rect.width) * 100;
  const y = ((event.clientY - state.drag.rect.top - state.drag.offsetY) / state.drag.rect.height) * 100;
  state.drag.node.style.left = `${Math.max(2, Math.min(82, x))}%`;
  state.drag.node.style.top = `${Math.max(5, Math.min(82, y))}%`;
});

canvas.addEventListener("pointerup", async (event) => {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  const x = Number.parseFloat(state.drag.node.style.left);
  const y = Number.parseFloat(state.drag.node.style.top);
  const drag = state.drag;
  state.drag = null;
  state.board = await api(`/api/boards/${state.board.id}/bubbles`, {
    method: "PATCH",
    body: userBody({ pageId: drag.pageId, bubbleId: drag.bubbleId, x, y })
  });
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
      ownerName: state.name
    }
  });
  state.ownerKey = board.ownerKey;
  localStorage.setItem("myfukidashi:ownerKey", state.ownerKey);
  state.board = board;
  state.currentPageId = board.currentPageId;
  setBoardUrl(board);
  render();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshBoard, 1600);
});

bubbleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = new FormData(bubbleForm).get("text");
  const text = String(input || "").trim();
  if (!text) return;
  bubbleForm.reset();
  await addBubble(text);
});

nameInput.addEventListener("input", () => {
  state.name = nameInput.value.trim();
  localStorage.setItem("myfukidashi:name", state.name);
});

addPageButton.addEventListener("click", async () => {
  const title = prompt("ページ名", `ページ ${state.board.pages.length + 1}`);
  if (!title) return;
  state.board = await api(`/api/boards/${state.board.id}/pages`, {
    method: "POST",
    body: userBody({ title })
  });
  state.currentPageId = state.board.currentPageId;
  render();
});

lockToggle.addEventListener("change", updatePageSettings);
hideToggle.addEventListener("change", updatePageSettings);

async function updatePageSettings() {
  state.board = await api(`/api/boards/${state.board.id}/page`, {
    method: "PATCH",
    body: userBody({
      pageId: activePage().id,
      lockEdits: lockToggle.checked,
      hideOthers: hideToggle.checked
    })
  });
  render();
}

gatherButton.addEventListener("click", async () => {
  state.board = await api(`/api/boards/${state.board.id}/page`, {
    method: "PATCH",
    body: userBody({ pageId: activePage().id, current: true })
  });
  render();
});

copyLinkButton.addEventListener("click", async () => {
  const url = shareUrl();
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(url);
    setStatus("共有リンクをコピーしました");
  } catch {
    prompt("共有リンクをコピーしてください", url);
    setStatus("共有リンクを表示しました");
  }
});

newBoardButton.addEventListener("click", () => {
  localStorage.removeItem("myfukidashi:ownerKey");
  location.href = "/";
});

const initialBoard = boardIdFromUrl();
if (initialBoard) {
  loadBoard(initialBoard).catch(() => {
    setStatus("ボードが見つかりません");
  });
}
