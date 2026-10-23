// AI 사무실 화면. 서버가 /api/run 으로 흘려보내는 이벤트를 받아
// ① 모니터링(진척도·팀원 현황·타임라인) ② 3D 사무실 ③ 보고함 세 화면에 반영한다.
// 세 화면은 한 페이지 안에서 전환되므로, 화면을 바꿔도 진행 중인 작업은 끊기지 않는다.

import { Office3D } from "./office3d.js";
import { announce, summarize, unlock, isVoiceEnabled, setVoiceEnabled } from "./voice.js";

const $ = (sel) => document.querySelector(sel);
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
const SEG_STATES = ["thinking", "searching", "working", "waiting", "error"];
const RUN_LABEL = { idle: "대기", running: "진행 중", done: "완료", error: "문제 발생", cancelled: "중단됨" };
const STEPS = ["업무 접수", "팀장 분배", "팀원 작업", "최종 정리", "완료"];
const EXAMPLES = [
  "중소기업을 위한 생성형 AI 도입 제안서를 써줘",
  "AI 교육 과정 홍보용 블로그 글 초안을 만들어줘",
  "2026년 국내 AI 에이전트 시장 동향을 조사해서 1페이지로 요약해줘",
];
const REPORTS_KEY = "aiOffice.reports";
const PASSCODE_KEY = "aiOffice.passcode";
// 역할별로 "무엇을 마쳤는지" 읽어 줄 말
const DONE_WORK = { researcher: "조사를", planner: "기획을", writer: "초안 작성을", reviewer: "검토를" };
const EXPECTED_TASKS = 4; // 진척도 계산 시 최소한 이만큼의 위임이 있다고 가정 (팀원 4명)

let office = null; // Office3D
let config = null;
const agents = new Map(); // id → 화면 상태
let mode = "demo";
let liveAvailable = false;
let needsPasscode = false;
let controller = null; // 진행 중인 작업 요청 (중단 버튼으로 끊는다)
let lastSeq = -1;
let managerSpeech = "";
let run = newRun(); // 현재(또는 마지막) 작업
let ticker = null;
let selectedReport = null;

function newRun() {
  return {
    status: "idle", task: "", mode: "demo", model: "", t0: 0, t1: 0,
    delegations: 0, reports: 0, searches: 0, cost: 0, costDemo: false,
    stage: -1, progress: 0, result: "", round: [],
  };
}

// ── 초기화 ───────────────────────────────
init();

async function init() {
  config = await fetch("/api/config").then((r) => r.json());
  liveAvailable = config.liveAvailable;
  needsPasscode = config.needsPasscode;
  try {
    office = new Office3D($("#office3d"), { onSelect: openAgentDialog });
  } catch (err) {
    console.error(err);
    $("#office3d").insertAdjacentHTML("beforeend", `<p class="office-error">이 브라우저에서는 3D 화면(WebGL)을 표시할 수 없습니다. 모니터링 화면에서 진행 상황을 확인할 수 있어요.</p>`);
    office = null;
  }
  for (const def of config.agents) buildAgent(def);
  buildLegends();
  buildExamples();
  setupMode();
  setupTabs();
  setupForm();
  setupOfficeHud();
  setupSound();
  $("#dialogClose").addEventListener("click", () => $("#agentDialog").close());
  window.addEventListener("hashchange", route);
  route();
  renderReportList();
  renderMonitor();
}

function buildAgent(def) {
  const a = {
    def, state: "idle", calls: [], bubbleKind: null, bubbleText: "", hideTimer: null,
    segs: [], openSeg: null, marks: [], activity: "", assigned: 0, completed: 0,
  };
  agents.set(def.id, a);
  office?.addAgent(def);
  // 팀원 현황 카드
  const el = document.createElement("button");
  el.type = "button";
  el.className = "member";
  el.style.setProperty("--c", def.color);
  el.innerHTML = `<div class="member-top">
      <img src="${def.photo}" alt="" />
      <div class="member-name"><b>${def.name} ${def.title}</b><small>${def.role}</small></div>
    </div>
    <span class="state-chip" data-state="idle"><i class="state-dot"></i><span>대기</span></span>
    <div class="member-activity">${escapeHtml(def.summary)}</div>
    <div class="member-foot"><span class="member-count"></span><span class="mini-bar"><i></i></span></div>`;
  el.addEventListener("click", () => openAgentDialog(def.id));
  $("#team").append(el);
  a.card = {
    chip: el.querySelector(".state-chip"),
    chipText: el.querySelector(".state-chip span"),
    activity: el.querySelector(".member-activity"),
    count: el.querySelector(".member-count"),
    bar: el.querySelector(".mini-bar i"),
  };
  updateMember(a);
}

function buildLegends() {
  const items = ["thinking", "searching", "working", "waiting"]
    .map((s) => `<span><i class="state-dot" data-state="${s}"></i>${STATE_LABEL[s]}</span>`)
    .join("");
  $("#legend").innerHTML = items + `<span>📋 지시 · 📄 보고 · 🔍 검색</span>`;
  $("#officeLegend").innerHTML = items + `<span>· 드래그로 회전, 휠로 확대 · 사람이나 이름표를 누르면 프로필과 작업 기록</span>`;
}

function buildExamples() {
  const box = $("#examples");
  for (const text of EXAMPLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      $("#task").value = text;
      autoGrow();
      $("#task").focus();
    });
    box.append(chip);
  }
}

function setupMode() {
  const buttons = document.querySelectorAll(".mode-switch button");
  const liveBtn = document.querySelector('.mode-switch [data-mode="live"]');
  if (!liveAvailable) {
    liveBtn.disabled = true;
    liveBtn.title = config.liveUnavailableReason || "서버에 ANTHROPIC_API_KEY가 설정되어 있지 않아요";
  }
  const hint = () => {
    $("#modeHint").textContent =
      mode === "live"
        ? `실제 AI: ${config.live.model} · 팀장 ${config.live.managerEffort} / 팀원 ${config.live.workerEffort}${config.live.webSearch ? " · 웹 검색" : ""} (API 비용 발생)`
        : "데모: 정해진 대본으로 흐름만 보여줍니다 · Enter로 지시, Shift+Enter 줄바꿈";
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
  // 접속 코드가 필요한 공개 배포에서는 비용이 없는 데모로 시작한다
  if (liveAvailable && !needsPasscode) liveBtn.click();
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

function setupForm() {
  const ta = $("#task");
  // 휴대폰에서는 입력창이 여러 줄로 커지지 않도록 짧은 안내 문구를 쓴다
  const narrow = window.matchMedia("(max-width: 760px)");
  const placeholder = () => (ta.placeholder = narrow.matches ? "팀에게 맡길 업무를 적어 주세요" : "팀에게 맡길 업무를 적어 주세요 — 예) 중소기업용 생성형 AI 도입 제안서 써줘");
  narrow.addEventListener("change", placeholder);
  placeholder();
  $("#taskForm").addEventListener("submit", onSubmit);
  $("#cancelBtn").addEventListener("click", onCancel);
  ta.addEventListener("input", autoGrow);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#taskForm").requestSubmit();
    }
  });
}

function autoGrow() {
  const ta = $("#task");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
}

function setupOfficeHud() {
  const camButtons = document.querySelectorAll("[data-cam]");
  for (const btn of camButtons) {
    btn.addEventListener("click", () => {
      office?.resetView(btn.dataset.cam);
      camButtons.forEach((b) => b.classList.toggle("active", b === btn));
    });
  }
  camButtons[0]?.classList.add("active");
  $("#autoRotate").addEventListener("change", (e) => office?.setAutoRotate(e.target.checked));
}

function setupSound() {
  const btn = $("#soundBtn");
  const paint = () => {
    const on = isVoiceEnabled();
    btn.setAttribute("aria-pressed", String(on));
    btn.firstChild.textContent = on ? "🔊 " : "🔇 ";
  };
  btn.addEventListener("click", () => {
    setVoiceEnabled(!isVoiceEnabled());
    paint();
    if (isVoiceEnabled()) {
      unlock();
      announce("음성 알림을 켰습니다. 단계가 끝날 때마다 알려 드릴게요.");
    }
  });
  paint();
}

// ── 화면 전환 (#/monitor · #/office · #/reports) ──
function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const view = ["monitor", "office", "reports"].includes(name) ? name : "monitor";
  for (const el of document.querySelectorAll(".view")) el.hidden = el.dataset.view !== view;
  for (const a of document.querySelectorAll(".nav a")) a.classList.toggle("active", a.dataset.view === view);
  office?.setActive(view === "office");
  if (view === "reports") renderReportList();
  window.scrollTo({ top: 0 });
}

// ── 작업 시작 / 중단 ─────────────────────
async function onSubmit(e) {
  e.preventDefault();
  if (controller) return;
  const task = $("#task").value.trim();
  if (!task) return $("#task").focus();

  const headers = { "Content-Type": "application/json" };
  if (mode === "live" && needsPasscode) {
    const code = getPasscode();
    if (!code) return;
    headers["X-Office-Passcode"] = code;
  }

  unlock(); // 이 클릭 안에서 소리를 허용받아 두면 이후 자동 음성 알림이 나온다
  resetRun();
  setBusy(true);
  controller = new AbortController();
  const signal = controller.signal;
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers,
      body: JSON.stringify({ task, mode }),
      signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.code === "bad_passcode") forgetPasscode();
      throw new Error(data.error || "작업을 시작하지 못했습니다.");
    }
    $("#task").value = "";
    autoGrow();
    agents.get("manager").calls.push({ instruction: task, thinking: "", text: "", searches: [] });
    await readStream(res.body);
    // 작업이 끝나기 전에 연결이 끊긴 경우 (서버 시간 제한 등)
    if (controller && controller.signal === signal) {
      handle({ seq: lastSeq + 1, type: "job_error", message: "서버와의 연결이 끊겼습니다. 업무 범위를 좁혀 다시 시도해 주세요." });
    }
  } catch (err) {
    if (signal.aborted) {
      endRun("cancelled");
      addEntry({ kind: "error", icon: "⏹️", html: "작업을 중단했습니다." });
    } else {
      if (run.status === "running") endRun("error");
      addEntry({ kind: "error", icon: "⚠️", html: escapeHtml(err.message) });
    }
    finish();
  }
}

function onCancel() {
  controller?.abort();
}

function getPasscode() {
  let code = "";
  try {
    code = sessionStorage.getItem(PASSCODE_KEY) || "";
  } catch {
    /* 저장소를 못 쓰는 환경이면 매번 묻는다 */
  }
  if (!code) {
    code = (prompt("실제 AI 모드 접속 코드를 입력해 주세요.\n(API 비용이 발생하는 모드라 코드를 아는 사람만 쓸 수 있어요)") || "").trim();
    if (code) {
      try {
        sessionStorage.setItem(PASSCODE_KEY, code);
      } catch {
        /* 무시 */
      }
    }
  }
  return code;
}

function forgetPasscode() {
  try {
    sessionStorage.removeItem(PASSCODE_KEY);
  } catch {
    /* 무시 */
  }
}

// 서버가 한 줄에 하나씩 보내는 JSON 이벤트를 읽어 화면에 반영한다
async function readStream(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue; // 연결 유지용 빈 줄
      const event = JSON.parse(line);
      if (event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      handle(event);
    }
  }
}

function setBusy(busy) {
  $("#submitBtn").disabled = busy;
  $("#submitBtn").textContent = busy ? "팀이 일하는 중…" : "업무 지시";
  $("#cancelBtn").hidden = !busy;
}

function resetRun() {
  lastSeq = -1;
  managerSpeech = "";
  clearTimeout(run.roundTimer);
  run = newRun();
  feed.innerHTML = "";
  resultEl.innerHTML = `<p class="empty">팀이 작업 중입니다. 완료되면 여기에 결과가 표시됩니다.</p>`;
  $("#resultDot").hidden = true;
  $("#cost").textContent = "$0.000";
  showTab("feed");
  for (const a of agents.values()) {
    Object.assign(a, { calls: [], segs: [], openSeg: null, marks: [], activity: "", assigned: 0, completed: 0 });
    setState(a.def.id, "idle");
    hideBubble(a, 0);
    updateMember(a);
  }
}

function finish() {
  controller = null;
  setBusy(false);
}

function endRun(status) {
  if (run.status !== "running") return;
  run.status = status;
  run.t1 = Date.now();
  for (const a of agents.values()) {
    closeSeg(a, run.t1);
    if (status !== "done" && a.state !== "idle") setState(a.def.id, "idle");
  }
  clearInterval(ticker);
  ticker = null;
  renderMonitor();
}

// ── 이벤트 처리 ──────────────────────────
function handle(ev) {
  const a = ev.agent && agents.get(ev.agent);
  switch (ev.type) {
    case "job_started":
      Object.assign(run, { status: "running", task: ev.task, mode: ev.mode, model: ev.model, t0: Date.now(), stage: 0, progress: 3 });
      addEntry({ kind: "milestone", icon: "🏢", html: `<span class="who">업무 접수</span><span class="meta">${escapeHtml(ev.model)}</span><div>${escapeHtml(ev.task)}</div>` });
      clearInterval(ticker);
      ticker = setInterval(renderMonitor, 500);
      break;

    case "status":
      setState(ev.agent, ev.state);
      if (ev.state === "idle" || ev.state === "done") hideBubble(a, 2500);
      if (ev.agent === "manager" && ev.state === "waiting") flushManagerSpeech();
      if (ev.agent === "manager" && run.stage < 1 && ev.state === "thinking") run.stage = 1;
      if (ev.agent === "manager" && ev.state === "working" && run.delegations > 0 && run.reports >= run.delegations && run.stage < 3) {
        run.stage = 3;
        announce(`팀원 작업 단계가 모두 끝났습니다. 위임한 업무 ${run.delegations}건을 다 받았고, 이제 팀장이 최종 보고서를 정리합니다.`);
      }
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
      run.searches++;
      a.calls.at(-1)?.searches.push(ev.query);
      a.marks.push({ t: Date.now(), icon: "🔍", title: ev.query || "웹 검색" });
      showBubble(a, "search", ev.query ? `"${ev.query}" 검색 중` : "웹 검색 중");
      setActivity(a, `🔍 ${ev.query || "웹 검색 중"}`);
      addEntry({ agent: a, html: `<span class="who">${fullName(ev.agent)}</span><span class="meta">웹 검색</span><div>🔍 ${escapeHtml(ev.query || "(검색어 확인 중)")}</div>` });
      break;
    }

    case "delegate": {
      flushManagerSpeech();
      run.delegations++;
      run.stage = 2;
      run.round.push(ev.to);
      // 팀장이 연달아 지시하는 동안은 기다렸다가, 한 번에 몇 명에게 맡겼는지 묶어서 알린다
      clearTimeout(run.roundTimer);
      run.roundTimer = setTimeout(announceRound, 1500);
      const to = agents.get(ev.to);
      const mgr = agents.get("manager");
      to.assigned++;
      mgr.assigned++;
      const call = { instruction: ev.instruction, thinking: "", text: "", searches: [] };
      to.calls.push(call);
      to.marks.push({ t: Date.now(), icon: "📋", title: "지시 받음: " + firstLine(ev.instruction) });
      setActivity(to, "📋 " + firstLine(ev.instruction));
      updateMember(mgr);
      addEntry({
        agent: mgr,
        html: `<span class="who">${fullName("manager")} → ${fullName(ev.to)}</span><span class="meta">업무 지시</span>
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
      run.reports++;
      const from = agents.get(ev.from);
      const mgr = agents.get("manager");
      const done = from.calls.at(-1);
      if (done) done.done = true;
      from.completed++;
      mgr.completed++;
      from.marks.push({ t: Date.now(), icon: "📄", title: `보고 · ${ev.text.length.toLocaleString()}자` });
      setActivity(from, `📄 보고 완료 · ${ev.text.length.toLocaleString()}자`);
      updateMember(mgr);
      hideBubble(from, 0);
      addEntry({
        agent: from,
        html: `<span class="who">${fullName(ev.from)} → ${fullName("manager")}</span><span class="meta">결과 보고 · ${ev.text.length.toLocaleString()}자</span>
          <details><summary>보고 내용 보기</summary><pre>${escapeHtml(ev.text)}</pre></details>`,
      });
      visit(ev.from, "manager", "📄");
      announce(`${fullName(ev.from)}, ${DONE_WORK[ev.from] || "맡은 업무를"} 마쳤습니다. 요약하면, ${summarize(ev.text)}`);
      break;
    }

    case "usage":
      run.cost = ev.totalCost;
      run.costDemo = Boolean(ev.demo);
      $("#cost").textContent = costText();
      break;

    case "notice":
      addEntry({ kind: "notice", icon: "ℹ️", html: (a ? `<span class="who">${fullName(ev.agent)}</span> ` : "") + escapeHtml(ev.message) });
      break;

    case "job_done":
      managerSpeech = "";
      run.result = ev.result;
      run.stage = 4;
      endRun("done");
      renderResult(ev.result);
      saveReport();
      addEntry({ kind: "milestone", icon: "✅", html: `<span class="who">최종 결과 완성</span><div>‘최종 결과’ 탭과 보고함에서 볼 수 있어요.</div>` });
      announce(`모든 업무를 다 했습니다. ${shortTask()} 결과를 요약하면, ${summarize(ev.result, 110)}. 자세한 내용은 보고함에서 확인하세요.`, "final");
      finish();
      showTab("result");
      break;

    case "job_error":
      addEntry({ kind: "error", icon: "⚠️", html: escapeHtml(ev.message) });
      announce("작업에 문제가 생겨 중단되었습니다. 진행 기록을 확인해 주세요.", "error");
      endRun("error");
      finish();
      break;
  }
  renderMonitor();
}

// 팀장이 한 번에 나눠 준 업무를 묶어서 알린다 ("분배 단계 완료")
function announceRound() {
  if (!run.round.length) return;
  const names = run.round.map((id) => agents.get(id).def.role);
  run.round = [];
  if (run.status !== "running") return;
  announce(`팀장이 업무 분배를 마쳤습니다. ${names.join(", ")}에게 일을 맡겼어요.`);
}

function shortTask() {
  const t = run.task.replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 40) + "…" : t;
}

function flushManagerSpeech() {
  const text = managerSpeech.trim();
  managerSpeech = "";
  if (!text) return;
  addEntry({ agent: agents.get("manager"), html: `<span class="who">${fullName("manager")}</span><div>${escapeHtml(text)}</div>` });
}

// ── 캐릭터 상태 · 말풍선 ──────────────────
function setState(id, state) {
  const a = agents.get(id);
  if (!a) return;
  if (a.state !== state && run.status === "running") {
    const now = Date.now();
    closeSeg(a, now);
    if (SEG_STATES.includes(state)) {
      a.openSeg = { state, t0: now, t1: null };
      a.segs.push(a.openSeg);
    }
  }
  a.state = state;
  office?.setState(id, state);
  updateMember(a);
}

function closeSeg(a, t) {
  if (a.openSeg) a.openSeg.t1 = t;
  a.openSeg = null;
}

// 한 캐릭터의 이동은 Office3D가 순서대로(큐) 처리한다. 팀장이 여러 팀원에게 동시에 지시하면 차례로 방문한다.
function visit(fromId, toId, carry) {
  return office ? office.visit(fromId, toId, carry) : Promise.resolve();
}

function speak(a, kind, delta) {
  if (a.bubbleKind !== kind) a.bubbleText = "";
  a.bubbleText += delta;
  const text = a.bubbleText.replace(/[#*`>|_-]{1,}/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return;
  showBubble(a, kind, text.length > 110 ? "…" + text.slice(-110) : text);
  setActivity(a, (kind === "thinking" ? "💭 " : "✍️ ") + (text.length > 90 ? "…" + text.slice(-90) : text));
}

function showBubble(a, kind, text) {
  clearTimeout(a.hideTimer);
  a.bubbleKind = kind;
  office?.showBubble(a.def.id, kind, text);
}

function hideBubble(a, delay) {
  clearTimeout(a.hideTimer);
  a.hideTimer = setTimeout(() => {
    office?.hideBubble(a.def.id);
    a.bubbleKind = null;
    a.bubbleText = "";
  }, delay);
}

function setActivity(a, text) {
  a.activity = text;
  a.card.activity.textContent = text;
}

function updateMember(a) {
  const c = a.card;
  if (!c) return;
  c.chip.dataset.state = a.state;
  c.chipText.textContent = STATE_LABEL[a.state] || a.state;
  if (!a.activity) c.activity.textContent = a.def.summary;
  const isMgr = a.def.id === "manager";
  c.count.textContent = isMgr ? `지시 ${a.assigned} · 보고 ${a.completed}` : `업무 ${a.assigned} · 완료 ${a.completed}`;
  c.bar.style.width = a.assigned ? `${Math.round((a.completed / a.assigned) * 100)}%` : "0%";
}

// ── 모니터링: 진척도 · 단계 · 지표 · 타임라인 ──
function computeProgress() {
  if (run.status === "idle") return 0;
  if (run.status === "done") return 100;
  let p = 3;
  if (run.stage >= 1) p = 10;
  if (run.stage >= 2) p = 15 + (70 * run.reports) / Math.max(run.delegations, EXPECTED_TASKS);
  if (run.stage >= 3) p = 90;
  // 위임이 새로 생겨 계산값이 내려가도 화면의 진척도는 뒤로 가지 않게 한다
  run.progress = Math.max(run.progress, Math.min(p, 97));
  return Math.round(run.progress);
}

function renderMonitor() {
  const pct = computeProgress();
  const status = run.status;
  const now = status === "running" ? Date.now() : run.t1 || run.t0;
  const elapsed = run.t0 ? now - run.t0 : 0;

  $("#hero").dataset.status = status;
  const badge = $("#statusBadge");
  badge.dataset.status = status;
  badge.textContent = RUN_LABEL[status];
  $("#taskTitle").textContent = run.task || "아직 지시한 업무가 없어요";
  $("#heroMeta").textContent = run.t0
    ? `${run.mode === "live" ? "실제 AI" : "데모"} · ${run.model} · ${clock(run.t0)} 시작${run.t1 ? ` · ${clock(run.t1)} ${RUN_LABEL[status]}` : ""}`
    : "아래 입력창에 업무를 적으면 팀장이 일을 나누고 팀원들이 협업을 시작합니다.";
  $("#progressFill").style.width = pct + "%";
  $("#progressBar").setAttribute("aria-valuenow", String(pct));
  $("#progressNum").textContent = pct + "%";
  const stage = status === "done" ? 4 : run.stage;
  document.querySelectorAll("#stepper li").forEach((li, i) => {
    li.classList.toggle("done", i < stage || status === "done");
    li.classList.toggle("current", i === stage && status !== "done");
  });
  $("#examples").hidden = status === "running";

  $("#kpiTime").textContent = duration(elapsed);
  $("#kpiTasks").textContent = `${run.reports} / ${run.delegations}`;
  $("#kpiSearch").textContent = `${run.searches}회`;
  $("#kpiCost").textContent = costText();

  const pill = $("#livePill");
  pill.dataset.status = status;
  $("#liveText").textContent = status === "idle" ? "대기 중" : `${RUN_LABEL[status]} · ${pct}%`;

  const os = $("#officeStatus");
  os.hidden = status === "idle";
  $("#officeTask").textContent = `${RUN_LABEL[status]} · ${run.task}`;
  $("#officeFill").style.width = pct + "%";
  $("#officePct").textContent = pct + "%";

  renderGantt(now);
}

function renderGantt(now) {
  const box = $("#gantt");
  if (!run.t0) return;
  const start = run.t0;
  const elapsed = Math.max(now - start, 1);
  const span = run.status === "running" ? Math.max(elapsed * 1.12, 20000) : Math.max(elapsed, 1000);
  const step = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].map((s) => s * 1000).find((s) => span / s <= 7) || 3600000;
  const pct = (t) => `${Math.min(100, ((t - start) / span) * 100).toFixed(3)}%`;

  const rows = [...agents.values()]
    .map((a) => {
      const segs = a.segs
        .map((s) => {
          const t1 = s.t1 ?? now;
          const w = ((t1 - s.t0) / span) * 100;
          return `<i class="g-seg${s.t1 ? "" : " open"}" data-state="${s.state}" style="left:${pct(s.t0)};width:${w.toFixed(3)}%" title="${STATE_LABEL[s.state]} · ${duration(t1 - s.t0)}"></i>`;
        })
        .join("");
      const marks = a.marks
        .map((m) => `<span class="g-mark" style="left:${pct(m.t)}" title="${escapeHtml(m.title)}">${m.icon}</span>`)
        .join("");
      return `<div class="g-row" style="--c:${a.def.color}">
          <div class="g-who"><img src="${a.def.photo}" alt="" /><span>${a.def.name} · ${a.def.role}</span></div>
          <div class="g-track" style="--tick:${((step / span) * 100).toFixed(3)}%">${segs}${marks}</div>
        </div>`;
    })
    .join("");
  let ticks = "";
  for (let t = 0; t <= span; t += step) ticks += `<span style="left:${((t / span) * 100).toFixed(3)}%">${duration(t)}</span>`;
  const nowLine = run.status === "running" ? `<div class="g-overlay"><i class="g-now" style="left:${pct(now)}"></i></div>` : "";
  box.innerHTML = `<div class="gantt-body">${rows}${nowLine}</div>
    <div class="g-axis"><span></span><div class="g-axis-track">${ticks}</div></div>`;
}

// ── 진행 기록 (세로 타임라인) ──────────────
function addEntry({ agent, icon, html, kind = "" }) {
  feed.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `entry ${kind}`;
  if (agent) el.style.setProperty("--c", agent.def.color);
  const t = run.t0 ? duration(Date.now() - run.t0) : "";
  el.innerHTML = `<span class="time">${t}</span><div class="icon">${agent ? face(agent.def) : icon}</div><div class="body">${html}</div>`;
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  feed.append(el);
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function renderMarkdown(md) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(md));
  return `<pre style="white-space:pre-wrap">${escapeHtml(md)}</pre>`;
}

function resultActions(md, extra = "") {
  return `<div class="result-actions">
      <button type="button" class="btn-ghost" data-act="copy">복사</button>
      <button type="button" class="btn-ghost" data-act="download">.md 저장</button>${extra}
    </div>`;
}

function wireResultActions(root, md, name) {
  root.querySelector('[data-act="copy"]')?.addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(md);
    e.target.textContent = "복사됨 ✓";
  });
  root.querySelector('[data-act="download"]')?.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `${name}.md` });
    link.click();
    URL.revokeObjectURL(url);
  });
}

function renderResult(md) {
  resultEl.innerHTML = resultActions(md, ` <a class="btn-ghost" href="#/reports" style="text-decoration:none">보고함에서 보기</a>`) + renderMarkdown(md);
  wireResultActions(resultEl, md, "AI사무실_결과");
  if (resultEl.hidden) $("#resultDot").hidden = false;
}

// ── 보고함 (이 브라우저에만 저장) ─────────────
function loadReports() {
  try {
    return JSON.parse(localStorage.getItem(REPORTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function storeReports(list) {
  try {
    localStorage.setItem(REPORTS_KEY, JSON.stringify(list.slice(0, 30)));
    return true;
  } catch {
    return false;
  }
}

function saveReport() {
  const report = {
    id: String(run.t0),
    task: run.task,
    mode: run.mode,
    model: run.model,
    startedAt: run.t0,
    durationMs: run.t1 - run.t0,
    cost: run.cost,
    costDemo: run.costDemo,
    delegations: run.delegations,
    searches: run.searches,
    result: run.result,
  };
  const list = loadReports().filter((r) => r.id !== report.id);
  list.unshift(report);
  storeReports(list);
  selectedReport = report.id;
  renderReportList();
}

function renderReportList() {
  const list = loadReports();
  const count = $("#reportCount");
  count.hidden = !list.length;
  count.textContent = String(list.length);
  const box = $("#reportList");
  if (!list.length) {
    box.innerHTML = `<p class="empty">아직 완료된 업무가 없어요. 업무를 지시하면 결과가 여기에 쌓입니다.</p>`;
    $("#reportDetail").innerHTML = `<p class="empty">왼쪽에서 보고서를 고르면 내용이 여기에 표시됩니다.</p>`;
    return;
  }
  if (!list.some((r) => r.id === selectedReport)) selectedReport = list[0].id;
  box.innerHTML = list
    .map(
      (r) => `<button type="button" class="report-item${r.id === selectedReport ? " active" : ""}" data-id="${r.id}">
        <b>${escapeHtml(r.task)}</b>
        <span class="row"><span class="tag${r.mode === "live" ? " live" : ""}">${r.mode === "live" ? "실제 AI" : "데모"}</span>
        <span>${dateTime(r.startedAt)}</span><span>⏱ ${duration(r.durationMs)}</span><span>위임 ${r.delegations}건</span></span>
      </button>`,
    )
    .join("");
  for (const btn of box.querySelectorAll(".report-item")) {
    btn.addEventListener("click", () => {
      selectedReport = btn.dataset.id;
      renderReportList();
      if (window.matchMedia("(max-width: 980px)").matches) $("#reportDetail").scrollIntoView({ behavior: "smooth" });
    });
  }
  renderReportDetail(list.find((r) => r.id === selectedReport));
}

function renderReportDetail(r) {
  const el = $("#reportDetail");
  el.innerHTML = `<div class="detail-head">
      <div>
        <h2>${escapeHtml(r.task)}</h2>
        <div class="muted small">${r.mode === "live" ? "실제 AI" : "데모"} · ${escapeHtml(r.model)} · ${dateTime(r.startedAt)} · 소요 ${duration(r.durationMs)} · 위임 ${r.delegations}건 · 검색 ${r.searches}회 · ${r.costDemo ? "~" : ""}$${(r.cost || 0).toFixed(3)}</div>
      </div>
    </div>
    ${resultActions(r.result, ` <button type="button" class="btn-ghost" data-act="again">같은 업무 다시 지시</button> <button type="button" class="btn-ghost" data-act="delete">삭제</button>`)}
    <div class="markdown">${renderMarkdown(r.result)}</div>`;
  wireResultActions(el, r.result, "AI사무실_" + r.task.slice(0, 20).replace(/[\\/:*?"<>|\s]+/g, "_"));
  el.querySelector('[data-act="again"]').addEventListener("click", () => {
    $("#task").value = r.task;
    autoGrow();
    $("#task").focus();
  });
  el.querySelector('[data-act="delete"]').addEventListener("click", () => {
    if (!confirm("이 보고서를 보고함에서 삭제할까요?")) return;
    storeReports(loadReports().filter((x) => x.id !== r.id));
    selectedReport = null;
    renderReportList();
  });
}

// ── 팀원 상세 창 ──────────────────────────
function openAgentDialog(id) {
  const a = agents.get(id);
  const d = a.def;
  $("#dialogTitle").innerHTML = `<div class="profile">
      <img class="profile-photo" src="${d.photo}" alt="${d.name} 프로필 사진" style="--c:${d.color}" />
      <div>
        <div class="title">${d.name} ${d.title} <span class="role-tag" style="--c:${d.color}">${d.role}</span></div>
        <div class="sub">${d.age}세 · ${escapeHtml(d.career)}</div>
        <div class="sub">${escapeHtml(d.personality)}</div>
        <div class="motto">“${escapeHtml(d.motto)}”</div>
      </div>
    </div>`;
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
// AI로 생성한 가상 인물 사진. 이미지를 못 불러오면 이모지로 대신한다.
function face(def) {
  return `<img class="face" src="${def.photo}" alt="${def.name}" onerror="this.replaceWith(document.createTextNode('${def.emoji}'))" />`;
}

function fullName(id) {
  const d = agents.get(id).def;
  return `${d.name} ${d.title}`;
}

function firstLine(text) {
  const line = text.split("\n").find((l) => l.trim()) || "";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

function costText() {
  return (run.costDemo ? "~$" : "$") + run.cost.toFixed(3);
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function clock(t) {
  return new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function dateTime(t) {
  return new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
