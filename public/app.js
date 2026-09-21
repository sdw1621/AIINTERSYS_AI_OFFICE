// AI 사무실 화면: 서버에서 오는 이벤트(SSE)를 받아 캐릭터 이동·말풍선·업무 기록으로 보여준다.

const $ = (sel) => document.querySelector(sel);
const office = $("#office");
const feed = $("#feed");
const resultEl = $("#result");

const STATE_LABEL = {
  idle: "대기",
  thinking: "생각 중",
  searching: "검색 중",
  working: "작성 중",
  waiting: "보고 대기",
  done: "완료",
  error: "문제 발생",
};

const EXAMPLES = [
  "중소기업을 위한 생성형 AI 도입 제안서를 써줘",
  "AI 교육 과정 홍보용 블로그 글 초안을 만들어줘",
  "2026년 국내 AI 에이전트 시장 동향을 조사해서 1페이지로 요약해줘",
];

const agents = new Map(); // id → { def, desk, avatar, bubble, home, queue, calls, bubbleKind, bubbleText, hideTimer }
let mode = "demo";
let liveAvailable = false;
let currentJob = null;
let source = null;
let lastSeq = -1;
let managerSpeech = "";

// ── 초기화 ───────────────────────────────
init();

async function init() {
  const config = await fetch("/api/config").then((r) => r.json());
  liveAvailable = config.liveAvailable;
  for (const def of config.agents) buildAgent(def);
  buildLegend();
  buildExamples();
  setupMode(config);
  setupTabs();
  $("#taskForm").addEventListener("submit", onSubmit);
  $("#cancelBtn").addEventListener("click", onCancel);
  $("#dialogClose").addEventListener("click", () => $("#agentDialog").close());
  $("#task").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#taskForm").requestSubmit();
  });
}

function buildAgent(def) {
  const desk = document.createElement("div");
  desk.className = "desk";
  desk.dataset.state = "idle";
  desk.style.left = def.desk.x + "%";
  desk.style.top = def.desk.y + "%";
  desk.innerHTML = `<div class="monitor"></div>
    <div class="nameplate"><span class="state-dot"></span>${def.name}<span class="state-label">${STATE_LABEL.idle}</span></div>`;
  desk.title = `${def.role} · ${def.summary}`;

  const home = { x: def.desk.x, y: def.desk.y - 11 };
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.style.setProperty("--c", def.color);
  avatar.innerHTML = `${def.emoji}<span class="carry"></span>`;
  avatar.title = `${def.name} (${def.role})`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  // 위쪽 끝에 있는 캐릭터는 말풍선이 잘리지 않도록 아래에 띄운다
  const below = home.y < 25;

  office.append(desk, avatar, bubble);
  const agent = { def, desk, avatar, bubble, home, below, queue: Promise.resolve(), calls: [], bubbleKind: null, bubbleText: "" };
  agents.set(def.id, agent);
  place(agent, home.x, home.y, 0);

  const open = () => openAgentDialog(def.id);
  desk.addEventListener("click", open);
  avatar.addEventListener("click", open);
}

function buildLegend() {
  $("#legend").innerHTML = ["thinking", "searching", "working", "waiting", "done"]
    .map((s) => `<span data-state="${s}"><span class="state-dot"></span>${STATE_LABEL[s]}</span>`)
    .join("") + `<span>· 책상이나 캐릭터를 누르면 그 팀원의 작업 기록을 볼 수 있어요</span>`;
}

function buildExamples() {
  const box = $("#examples");
  for (const text of EXAMPLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = text;
    chip.addEventListener("click", () => ($("#task").value = text));
    box.append(chip);
  }
}

function setupMode(config) {
  const buttons = document.querySelectorAll(".mode-switch button");
  const liveBtn = document.querySelector('.mode-switch [data-mode="live"]');
  if (!liveAvailable) {
    liveBtn.disabled = true;
    liveBtn.title = ".env 파일에 ANTHROPIC_API_KEY를 넣고 서버를 다시 시작하면 쓸 수 있어요";
  }
  const hint = () => {
    $("#modeHint").textContent =
      mode === "live"
        ? `실제 AI: ${config.live.model} · 팀장 ${config.live.managerEffort} / 팀원 ${config.live.workerEffort}${config.live.webSearch ? " · 웹 검색" : ""} (API 비용 발생)`
        : "데모: 정해진 대본으로 흐름만 보여줍니다";
  };
  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      mode = btn.dataset.mode;
      buttons.forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-checked", String(b === btn));
      });
      hint();
    });
  }
  if (liveAvailable) liveBtn.click();
  hint();
}

function setupTabs() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  }
}

function showTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
  }
  feed.hidden = name !== "feed";
  resultEl.hidden = name !== "result";
  if (name === "result") $("#resultDot").hidden = true;
}

// ── 작업 시작 / 중단 ─────────────────────
async function onSubmit(e) {
  e.preventDefault();
  const task = $("#task").value.trim();
  if (!task) return $("#task").focus();

  resetOffice();
  setBusy(true);
  try {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, mode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "작업을 시작하지 못했습니다.");
    currentJob = data.id;
    agents.get("manager").calls.push({ instruction: task, thinking: "", text: "", searches: [] });
    listen(data.id);
  } catch (err) {
    addEntry({ kind: "error", icon: "⚠️", html: escapeHtml(err.message) });
    setBusy(false);
  }
}

async function onCancel() {
  if (!currentJob) return;
  await fetch(`/api/jobs/${currentJob}/cancel`, { method: "POST" });
}

function setBusy(busy) {
  $("#submitBtn").disabled = busy;
  $("#submitBtn").textContent = busy ? "팀이 일하는 중…" : "업무 지시";
  $("#cancelBtn").hidden = !busy;
}

function resetOffice() {
  source?.close();
  lastSeq = -1;
  managerSpeech = "";
  feed.innerHTML = "";
  resultEl.innerHTML = `<p class="empty">팀이 작업 중입니다. 완료되면 여기에 결과가 표시됩니다.</p>`;
  $("#resultDot").hidden = true;
  $("#cost").textContent = "$0.000";
  showTab("feed");
  for (const a of agents.values()) {
    a.calls = [];
    setState(a.def.id, "idle");
    hideBubble(a, 0);
  }
}

function listen(jobId) {
  source = new EventSource(`/api/jobs/${jobId}/events`);
  source.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    if (event.seq <= lastSeq) return; // 재연결 시 서버가 처음부터 다시 보내므로 중복은 건너뛴다
    lastSeq = event.seq;
    handle(event);
  };
}

// ── 이벤트 처리 ──────────────────────────
function handle(ev) {
  const a = ev.agent && agents.get(ev.agent);
  switch (ev.type) {
    case "job_started":
      addEntry({ icon: "🏢", html: `<span class="who">업무 접수</span><span class="meta">${escapeHtml(ev.model)}</span><div>${escapeHtml(ev.task)}</div>` });
      break;

    case "status":
      setState(ev.agent, ev.state);
      if (ev.state === "idle" || ev.state === "done") hideBubble(a, 2500);
      if (ev.agent === "manager" && ev.state === "waiting") flushManagerSpeech();
      break;

    case "thinking":
    case "text": {
      const call = a.calls.at(-1);
      if (call) call[ev.type] += ev.text;
      if (ev.agent === "manager" && ev.type === "text") managerSpeech += ev.text;
      speak(a, ev.type, ev.text);
      break;
    }

    case "search": {
      a.calls.at(-1)?.searches.push(ev.query);
      showBubble(a, "search", ev.query ? `"${ev.query}" 검색 중` : "웹 검색 중");
      addEntry({ agent: a, html: `<span class="who">${a.def.name}</span><span class="meta">웹 검색</span><div>🔍 ${escapeHtml(ev.query || "(검색어 확인 중)")}</div>` });
      break;
    }

    case "delegate": {
      flushManagerSpeech();
      const to = agents.get(ev.to);
      const call = { instruction: ev.instruction, thinking: "", text: "", searches: [] };
      to.calls.push(call);
      addEntry({
        agent: agents.get("manager"),
        html: `<span class="who">김팀장 → ${to.def.name}</span><span class="meta">업무 지시</span>
          <div>${escapeHtml(firstLine(ev.instruction))}</div>
          <details><summary>지시 전문 보기</summary><pre>${escapeHtml(ev.instruction)}</pre></details>`,
      });
      visit("manager", ev.to, "📋").then(() => {
        if (to.bubbleKind || call.thinking || call.text || call.done) return; // 이미 일을 시작했으면 인사 말풍선은 생략
        showBubble(to, "ack", "알겠습니다! " + firstLine(ev.instruction));
        hideBubble(to, 3000);
      });
      break;
    }

    case "report": {
      const from = agents.get(ev.from);
      const done = from.calls.at(-1);
      if (done) done.done = true;
      hideBubble(from, 0);
      addEntry({
        agent: from,
        html: `<span class="who">${from.def.name} → 김팀장</span><span class="meta">결과 보고 · ${ev.text.length.toLocaleString()}자</span>
          <details><summary>보고 내용 보기</summary><pre>${escapeHtml(ev.text)}</pre></details>`,
      });
      visit(ev.from, "manager", "📄");
      break;
    }

    case "usage":
      $("#cost").textContent = (ev.demo ? "~$" : "$") + ev.totalCost.toFixed(3);
      break;

    case "notice":
      addEntry({ kind: "notice", icon: "ℹ️", html: (a ? `<span class="who">${a.def.name}</span> ` : "") + escapeHtml(ev.message) });
      break;

    case "job_done":
      managerSpeech = "";
      renderResult(ev.result);
      addEntry({ icon: "✅", html: `<span class="who">최종 결과 완성</span><div>‘최종 결과’ 탭에서 확인하세요.</div>` });
      finish();
      showTab("result");
      break;

    case "job_error":
      addEntry({ kind: "error", icon: "⚠️", html: escapeHtml(ev.message) });
      for (const x of agents.values()) if (x.desk.dataset.state !== "idle") setState(x.def.id, "idle");
      finish();
      break;
  }
}

function finish() {
  source?.close();
  currentJob = null;
  setBusy(false);
}

function flushManagerSpeech() {
  const text = managerSpeech.trim();
  managerSpeech = "";
  if (!text) return;
  addEntry({ agent: agents.get("manager"), html: `<span class="who">김팀장</span><div>${escapeHtml(text)}</div>` });
}

// ── 캐릭터 표현 ──────────────────────────
function setState(id, state) {
  const a = agents.get(id);
  if (!a) return;
  a.desk.dataset.state = state;
  a.desk.querySelector(".state-label").textContent = STATE_LABEL[state] || state;
}

function place(a, x, y, ms) {
  for (const el of [a.avatar, a.bubble]) {
    el.style.setProperty("--walk", ms + "ms");
    el.style.left = x + "%";
    el.style.top = y + "%";
  }
  a.pos = { x, y };
}

function walk(a, x, y) {
  const dist = Math.hypot(x - a.pos.x, (y - a.pos.y) * 0.7);
  const ms = Math.max(500, dist * 28);
  a.avatar.classList.add("walking");
  place(a, x, y, ms);
  return sleep(ms).then(() => a.avatar.classList.remove("walking"));
}

// 한 캐릭터의 이동은 순서대로(큐) 처리한다. 팀장이 여러 팀원에게 동시에 지시하면 차례로 방문한다.
function visit(fromId, toId, carry) {
  const a = agents.get(fromId);
  const target = agents.get(toId);
  const side = target.def.desk.x < 50 ? 1 : -1;
  const tx = target.def.desk.x + side * 11;
  const ty = target.def.desk.y + (toId === "manager" ? 6 : -2);
  const job = a.queue.then(async () => {
    a.avatar.querySelector(".carry").textContent = carry;
    a.avatar.classList.add("carrying");
    await walk(a, tx, ty);
    a.avatar.classList.remove("carrying");
    await sleep(650);
    await walk(a, a.home.x, a.home.y);
  });
  a.queue = job;
  return job;
}

function speak(a, kind, delta) {
  if (a.bubbleKind !== kind) a.bubbleText = "";
  a.bubbleText += delta;
  const text = a.bubbleText.replace(/[#*`>|_-]{1,}/g, " ").replace(/\s+/g, " ").trim();
  if (text) showBubble(a, kind, text.length > 110 ? "…" + text.slice(-110) : text);
}

function showBubble(a, kind, text) {
  clearTimeout(a.hideTimer);
  a.bubbleKind = kind;
  a.bubble.className = `bubble show ${kind}${a.below ? " below" : ""}`;
  a.bubble.textContent = text;
}

function hideBubble(a, delay) {
  clearTimeout(a.hideTimer);
  a.hideTimer = setTimeout(() => {
    a.bubble.classList.remove("show");
    a.bubbleKind = null;
    a.bubbleText = "";
  }, delay);
}

// ── 기록 / 결과 / 상세 창 ─────────────────
function addEntry({ agent, icon, html, kind = "" }) {
  feed.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `entry ${kind}`;
  if (agent) el.style.setProperty("--c", agent.def.color);
  el.innerHTML = `<div class="icon">${agent ? agent.def.emoji : icon}</div><div class="body">${html}</div>`;
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  feed.append(el);
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function renderMarkdown(md) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(md));
  return `<pre style="white-space:pre-wrap">${escapeHtml(md)}</pre>`;
}

function renderResult(md) {
  resultEl.innerHTML = `<div class="result-actions">
      <button type="button" class="btn-ghost" id="copyBtn">복사</button>
      <button type="button" class="btn-ghost" id="downloadBtn">.md 저장</button>
    </div>${renderMarkdown(md)}`;
  $("#copyBtn").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(md);
    e.target.textContent = "복사됨 ✓";
  });
  $("#downloadBtn").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: "AI사무실_결과.md" });
    link.click();
    URL.revokeObjectURL(url);
  });
  if (resultEl.hidden) $("#resultDot").hidden = false;
}

function openAgentDialog(id) {
  const a = agents.get(id);
  $("#dialogTitle").innerHTML = `<div class="title">${a.def.emoji} ${a.def.name} · ${a.def.role}</div><div class="sub">${escapeHtml(a.def.summary)}</div>`;
  const body = $("#dialogBody");
  if (!a.calls.length) {
    body.innerHTML = `<p class="empty">아직 맡은 업무가 없습니다.</p>`;
  } else {
    body.innerHTML = a.calls
      .map(
        (c, i) => `<div class="call">
          <h4>${id === "manager" ? "받은 요청" : `업무 ${i + 1} · 팀장 지시`}</h4>
          <div class="instruction">${escapeHtml(c.instruction)}</div>
          ${c.searches.length ? `<p class="thought">🔍 ${c.searches.map(escapeHtml).join(" · ")}</p>` : ""}
          ${c.thinking ? `<details><summary class="thought">💭 생각 요약 보기</summary><div class="thought">${escapeHtml(c.thinking)}</div></details>` : ""}
          <div class="markdown">${c.text ? renderMarkdown(c.text) : `<p class="empty">작업 중…</p>`}</div>
        </div>`,
      )
      .join("");
  }
  $("#agentDialog").showModal();
}

// ── 유틸 ────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function firstLine(text) {
  const line = text.split("\n").find((l) => l.trim()) || "";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
