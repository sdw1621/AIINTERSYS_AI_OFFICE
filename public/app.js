// AI 타워 화면. 서버가 /api/run 으로 흘려보내는 이벤트를 받아
// ① 모니터링(진척도·조직 현황·타임라인) ② 3D 타워 ③ 보고함 세 화면에 반영한다.
// 세 화면은 한 페이지 안에서 전환되므로, 화면을 바꿔도 진행 중인 작업은 끊기지 않는다.
// 조직: 총괄 본부장 → 팀장 4명 → 팀원 (모두 가상 인물)

import { Office3D } from "./office3d.js";
import { announce, summarize, unlock, isVoiceEnabled, setVoiceEnabled } from "./voice.js";
import { ACCEPT, MAX_BODY, readMaterialFile, describe } from "./materials.js";

const $ = (sel) => document.querySelector(sel);
const feed = $("#feed");
const resultEl = $("#result");

const STATE_LABEL = {
  idle: "대기",
  thinking: "생각 중",
  searching: "자료·검색",
  working: "작성 중",
  waiting: "보고 대기",
  done: "완료",
  error: "문제 발생",
};
const SEG_STATES = ["thinking", "searching", "working", "waiting", "error"];
const RUN_LABEL = { idle: "대기", running: "진행 중", done: "완료", error: "문제 발생", cancelled: "중단됨" };
const EXAMPLES = [
  "첨부한 3사 AX 실행계획을 비교 분석해서 공통 교육·PoC 우선순위와 회사별 보완점을 정리해줘",
  "중소기업을 위한 생성형 AI 도입 제안서를 써줘",
  "2026년 국내 AI 에이전트 시장 동향을 조사해서 1페이지로 요약해줘",
];
const REPORTS_KEY = "aiOffice.reports";
const PASSCODE_KEY = "aiOffice.passcode";
// 본부장에게 올라오는 보고를 읽어 줄 때 "무엇을 마쳤는지"
const DONE_WORK = {
  researcher: "리서치팀 조사를", planner: "기획팀 설계를", writer: "콘텐츠팀 초안 작성을", reviewer: "품질검토팀 검토를",
  secretary: "자료 정리를", strategist: "전략 분석을",
};
const EXPECTED_TASKS = 8;
const MODE_LABEL = { live: "실제 AI", demo: "데모", claude: "지피·구독" };
const modeLabel = (m) => MODE_LABEL[m] || m;
let replayTimers = []; // 진척도 계산 시 최소한 이만큼의 위임이 있다고 가정

let office = null; // Office3D
let config = null;
const agents = new Map(); // id → 화면 상태
const teamEls = new Map(); // 팀 key → 조직 현황 블록
let mode = "demo";
let liveAvailable = false;
let needsPasscode = false;
let controller = null; // 진행 중인 작업 요청 (중단 버튼으로 끊는다)
let lastSeq = -1;
let managerSpeech = "";
let run = newRun(); // 현재(또는 마지막) 작업
let ticker = null;
let selectedReport = null;
let attachments = []; // { id, name, status: loading|ready|error, data, message }
let dbReports = null; // 공용 보고함(DB) 목록 캐시
let followTimer = null;

function newRun() {
  return {
    status: "idle", task: "", mode: "demo", model: "", t0: 0, t1: 0, jobId: "",
    delegations: 0, reports: 0, searches: 0, reads: 0, cost: 0, costDemo: false,
    mgrDelegations: 0, mgrReports: 0, materials: [],
    stage: -1, progress: 0, result: "", round: [], savedToDb: false,
  };
}

// ── 초기화 ───────────────────────────────
init();

async function init() {
  config = await fetch("/api/config").then((r) => r.json());
  liveAvailable = config.liveAvailable;
  needsPasscode = config.needsPasscode;
  try {
    office = new Office3D($("#office3d"), { onSelect: openAgentDialog, floors: config.floors, teams: config.teams, onFloor: paintFloorButtons });
  } catch (err) {
    console.error(err);
    $("#office3d").insertAdjacentHTML("beforeend", `<p class="office-error">이 브라우저에서는 3D 화면(WebGL)을 표시할 수 없습니다. 모니터링 화면에서 진행 상황을 확인할 수 있어요.</p>`);
    office = null;
  }
  buildOrg();
  for (const def of config.agents) buildAgent(def);
  office?.finishBuild();
  buildLegends();
  buildExamples();
  setupMode();
  setupTabs();
  setupForm();
  setupAttachments();
  setupOfficeHud();
  setupSound();
  $("#dialogClose").addEventListener("click", () => $("#agentDialog").close());
  window.addEventListener("hashchange", route);
  route();
  renderReportList();
  renderMonitor();
}

// 조직 현황: 팀(층 순서)마다 블록 하나
function buildOrg() {
  const order = config.floors.flatMap((f) => f.teams);
  for (const key of order) {
    const t = config.teams[key];
    const el = document.createElement("div");
    el.className = "team-block";
    el.style.setProperty("--c", t.color);
    el.innerHTML = `<div class="team-head"><b>${t.floor}F · ${t.name}</b><span class="team-count"></span></div>`;
    $("#org").append(el);
    teamEls.set(key, { el, count: el.querySelector(".team-count") });
  }
  $("#orgCount").textContent = `${config.agents.length}명`;
}

function buildAgent(def) {
  const a = {
    def, state: "idle", calls: [], bubbleKind: null, bubbleText: "", hideTimer: null,
    segs: [], openSeg: null, marks: [], activity: "", assigned: 0, completed: 0,
  };
  agents.set(def.id, a);
  office?.addAgent(def);
  const el = document.createElement("button");
  el.type = "button";
  el.className = `person ${def.lead && def.lead !== "manager" ? "p-member" : "p-lead"}`;
  el.style.setProperty("--c", def.color);
  el.innerHTML = `<img src="${def.photo}" alt="" />
    <span class="person-name">${def.name} ${def.title}<small>${def.role}</small></span>
    <span class="state-chip" data-state="idle"><i class="state-dot"></i><span>대기</span></span>
    <span class="person-activity">${escapeHtml(def.summary)}</span>`;
  el.addEventListener("click", () => openAgentDialog(def.id));
  teamEls.get(def.team).el.append(el);
  a.card = {
    chip: el.querySelector(".state-chip"),
    chipText: el.querySelector(".state-chip span"),
    activity: el.querySelector(".person-activity"),
  };
  updateMember(a);
}

function buildLegends() {
  const items = ["thinking", "searching", "working", "waiting"]
    .map((s) => `<span><i class="state-dot" data-state="${s}"></i>${STATE_LABEL[s]}</span>`)
    .join("");
  $("#legend").innerHTML = items + `<span>📋 지시 · 📄 보고 · 📚 자료 · 🔍 검색</span>`;
  $("#officeLegend").innerHTML = items + `<span>· 층을 골라 들어가 보기 · 드래그로 회전, 휠로 확대 · 사람을 누르면 프로필과 작업 기록</span>`;
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
        ? `실제 AI: ${config.live.model} · 본부장 ${config.live.managerEffort} / 팀장 ${config.live.leadEffort} / 팀원 ${config.live.workerEffort}${config.live.webSearch ? " · 웹 검색" : ""} (API 비용 발생)`
        : "데모: 정해진 대본으로 흐름만 보여줍니다 · 📎로 자료 첨부 · Enter로 지시, Shift+Enter 줄바꿈";
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
  const placeholder = () => (ta.placeholder = narrow.matches ? "팀에게 맡길 업무를 적어 주세요" : "팀에게 맡길 업무를 적어 주세요 — 📎로 자료도 함께 올릴 수 있어요");
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

// ── 자료 첨부 ────────────────────────────
function setupAttachments() {
  const input = $("#fileInput");
  input.accept = ACCEPT;
  input.addEventListener("change", () => {
    addFiles([...input.files]);
    input.value = "";
  });
  // 지시창에 파일을 끌어다 놓아도 첨부된다
  const bar = $("#taskForm");
  bar.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  bar.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });
}

function addFiles(files) {
  for (const file of files) {
    if (attachments.length >= 10) {
      alert("자료는 한 번에 10개까지 올릴 수 있어요.");
      break;
    }
    const item = { id: crypto.randomUUID(), name: file.name, status: "loading" };
    attachments.push(item);
    readMaterialFile(file)
      .then((data) => Object.assign(item, { status: "ready", data }))
      .catch((err) => Object.assign(item, { status: "error", message: err.message }))
      .finally(renderAttachments);
  }
  renderAttachments();
}

function renderAttachments() {
  const box = $("#attachList");
  box.hidden = !attachments.length;
  box.innerHTML = attachments
    .map((a) => {
      const meta = a.status === "loading" ? "읽는 중" : a.status === "error" ? a.message : describe(a.data);
      return `<span class="att ${a.status === "ready" ? "" : a.status}" title="${escapeHtml(a.name)}">📄 <b>${escapeHtml(a.name)}</b><small>${escapeHtml(meta)}</small>
        <button type="button" data-remove="${a.id}" aria-label="${escapeHtml(a.name)} 빼기">✕</button></span>`;
    })
    .join("");
  for (const btn of box.querySelectorAll("[data-remove]")) {
    btn.addEventListener("click", () => {
      attachments = attachments.filter((a) => a.id !== btn.dataset.remove);
      renderAttachments();
    });
  }
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
  // 층 선택: 전체 타워 + 층별
  const box = $("#floorSwitch");
  const items = [{ floor: 0, name: "🏙️ 전체 타워" }, ...config.floors];
  box.innerHTML = items
    .map((f) => `<button type="button" data-floor="${f.floor}">${f.name}<i class="busy" hidden></i></button>`)
    .join("");
  for (const btn of box.querySelectorAll("button")) {
    btn.addEventListener("click", () => office?.focusFloor(Number(btn.dataset.floor)));
  }
  paintFloorButtons(0);
}

function paintFloorButtons(current) {
  for (const btn of document.querySelectorAll("#floorSwitch button")) btn.classList.toggle("active", Number(btn.dataset.floor) === current);
}

// 일이 진행되는 층으로 화면을 옮긴다 (너무 자주 흔들리지 않게 잠깐씩 머문다)
function follow(agentId) {
  if (!office || !$("#followWork").checked || !agents.has(agentId)) return;
  if (followTimer) return;
  office.focusFloor(agents.get(agentId).def.floor);
  followTimer = setTimeout(() => (followTimer = null), 6000);
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
  if (view === "reports") {
    renderReportList();
    loadDbReports();
  }
  window.scrollTo({ top: 0 });
}

// ── 작업 시작 / 중단 ─────────────────────
async function onSubmit(e) {
  e.preventDefault();
  if (controller) return;
  const task = $("#task").value.trim();
  if (!task) return $("#task").focus();
  if (attachments.some((a) => a.status === "loading")) return alert("자료를 아직 읽는 중이에요. 잠시 후 다시 눌러 주세요.");
  const materials = attachments.filter((a) => a.status === "ready").map((a) => a.data);
  const body = JSON.stringify({ task, mode, materials });
  if (body.length > MAX_BODY) return alert(`첨부 자료가 너무 커요 (${(body.length / 1e6).toFixed(1)}MB). 4MB 이하가 되도록 자료를 줄여 주세요.`);

  const headers = { "Content-Type": "application/json" };
  if (needsPasscode) {
    // 실제 모드는 접속 코드가 꼭 필요하고, 데모는 코드가 저장돼 있으면 함께 보내 공용 보고함에 남긴다
    const code = mode === "live" ? getPasscode() : storedPasscode();
    if (mode === "live" && !code) return;
    if (code) headers["X-Office-Passcode"] = code;
  }

  unlock(); // 이 클릭 안에서 소리를 허용받아 두면 이후 자동 음성 알림이 나온다
  resetRun();
  setBusy(true);
  controller = new AbortController();
  const signal = controller.signal;
  try {
    const res = await fetch("/api/run", { method: "POST", headers, body, signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.code === "bad_passcode") forgetPasscode();
      throw new Error(data.error || (res.status === 413 ? "첨부 자료가 너무 큽니다." : "작업을 시작하지 못했습니다."));
    }
    $("#task").value = "";
    autoGrow();
    attachments = [];
    renderAttachments();
    agents.get("manager").calls.push({ instruction: task, thinking: "", text: "", searches: [], reads: [] });
    await readStream(res.body);
    // 작업이 끝나기 전에 연결이 끊긴 경우 (서버 시간 제한 등)
    if (controller && controller.signal === signal) {
      handle({ seq: lastSeq + 1, type: "job_error", message: "서버와의 연결이 끊겼습니다. 업무 범위를 좁히거나 팀 수를 줄여 다시 시도해 주세요." });
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
// (다시 보기 중에는 controller.abort가 stopReplay를 부른다)

function storedPasscode() {
  try {
    return localStorage.getItem(PASSCODE_KEY) || "";
  } catch {
    return "";
  }
}

function getPasscode() {
  let code = storedPasscode();
  if (!code) {
    code = (prompt("접속 코드를 입력해 주세요.\n(실제 AI 모드와 공용 보고함은 코드를 아는 사람만 쓸 수 있어요)") || "").trim();
    if (code) {
      try {
        localStorage.setItem(PASSCODE_KEY, code);
      } catch {
        /* 무시 */
      }
    }
  }
  return code;
}

function forgetPasscode() {
  try {
    localStorage.removeItem(PASSCODE_KEY);
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
  replayTimers.forEach(clearTimeout);
  replayTimers = [];
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
      Object.assign(run, {
        status: "running", task: ev.task, mode: ev.mode, model: ev.model, t0: Date.now(), stage: 0, progress: 3,
        jobId: ev.id || "", materials: ev.materials || [],
      });
      addEntry({
        kind: "milestone", icon: "🏙️",
        html: `<span class="who">업무 접수</span><span class="meta">${escapeHtml(ev.model)}</span><div>${escapeHtml(ev.task)}</div>${
          run.materials.length ? `<div class="meta" style="margin:2px 0 0">📎 ${run.materials.map((m) => escapeHtml(m.name)).join(", ")}</div>` : ""}`,
      });
      clearInterval(ticker);
      ticker = setInterval(renderMonitor, 500);
      break;

    case "status":
      setState(ev.agent, ev.state);
      if (["thinking", "working", "searching"].includes(ev.state)) follow(ev.agent);
      if (ev.state === "idle" || ev.state === "done") hideBubble(a, 2500);
      if (ev.agent === "manager" && ev.state === "waiting") flushManagerSpeech();
      if (ev.agent === "manager" && run.stage < 1 && ev.state === "thinking") run.stage = 1;
      if (ev.agent === "manager" && ev.state === "working" && run.mgrDelegations > 0 && run.mgrReports >= run.mgrDelegations && run.stage < 3) {
        run.stage = 3;
        announce(`팀별 작업이 모두 끝났습니다. 본부장이 받은 보고 ${run.mgrReports}건을 바탕으로 최종 보고서를 정리합니다.`);
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

    case "read": {
      run.reads++;
      a.calls.at(-1)?.reads?.push(ev.name);
      a.marks.push({ t: Date.now(), icon: "📚", title: `자료 열람: ${ev.name}` });
      showBubble(a, "search", `📚 ${ev.name}${ev.parts > 1 ? ` (${ev.part}/${ev.parts})` : ""} 읽는 중`);
      setActivity(a, `📚 ${ev.name} 읽는 중`);
      addEntry({ agent: a, html: `<span class="who">${fullName(ev.agent)}</span><span class="meta">자료 열람</span><div>📚 ${escapeHtml(ev.name)}${ev.parts > 1 ? ` · ${ev.part}/${ev.parts}부분` : ""}</div>` });
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
      if (ev.from === "manager") flushManagerSpeech();
      run.delegations++;
      run.stage = Math.max(run.stage, 2);
      const from = agents.get(ev.from);
      const to = agents.get(ev.to);
      if (ev.from === "manager") {
        run.mgrDelegations++;
        run.round.push(ev.to);
        // 본부장이 연달아 지시하는 동안은 기다렸다가, 한 번에 어디에 맡겼는지 묶어서 알린다
        clearTimeout(run.roundTimer);
        run.roundTimer = setTimeout(announceRound, 1500);
      }
      to.assigned++;
      from.assigned++;
      const call = { instruction: ev.instruction, thinking: "", text: "", searches: [], reads: [] };
      to.calls.push(call);
      to.marks.push({ t: Date.now(), icon: "📋", title: `${from.def.name}의 지시: ${firstLine(ev.instruction)}` });
      setActivity(to, "📋 " + firstLine(ev.instruction));
      updateMember(from);
      addEntry({
        agent: from,
        html: `<span class="who">${fullName(ev.from)} → ${fullName(ev.to)}</span><span class="meta">업무 지시${from.def.floor !== to.def.floor ? ` · ${from.def.floor}F→${to.def.floor}F` : ""}</span>
          <div>${escapeHtml(firstLine(ev.instruction))}</div>
          <details><summary>지시 전문 보기</summary><pre>${escapeHtml(ev.instruction)}</pre></details>`,
      });
      visit(ev.from, ev.to, "📋").then(() => {
        if (to.bubbleKind || call.thinking || call.text || call.done) return; // 이미 일을 시작했으면 인사 말풍선은 생략
        showBubble(to, "ack", "알겠습니다! " + firstLine(ev.instruction));
        hideBubble(to, 3000);
      });
      break;
    }

    case "report": {
      run.reports++;
      const from = agents.get(ev.from);
      const to = agents.get(ev.to);
      const done = from.calls.at(-1);
      if (done) done.done = true;
      from.completed++;
      to.completed++;
      from.marks.push({ t: Date.now(), icon: "📄", title: `${to.def.name}에게 보고 · ${ev.text.length.toLocaleString()}자` });
      setActivity(from, `📄 ${to.def.name}에게 보고 완료 · ${ev.text.length.toLocaleString()}자`);
      updateMember(to);
      hideBubble(from, 0);
      addEntry({
        agent: from,
        html: `<span class="who">${fullName(ev.from)} → ${fullName(ev.to)}</span><span class="meta">결과 보고 · ${ev.text.length.toLocaleString()}자</span>
          <details><summary>보고 내용 보기</summary><pre>${escapeHtml(ev.text)}</pre></details>`,
      });
      visit(ev.from, ev.to, "📄");
      if (ev.to === "manager") {
        run.mgrReports++;
        announce(`${fullName(ev.from)}, ${DONE_WORK[ev.from] || "맡은 업무를"} 마쳤습니다. 요약하면, ${summarize(ev.text)}`);
      }
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
      if (!run.replay) saveLocalReport();
      addEntry({ kind: "milestone", icon: "✅", html: `<span class="who">최종 결과 완성</span><div>‘최종 결과’ 탭과 보고함에서 볼 수 있어요.</div>` });
      announce(`모든 업무를 다 했습니다. ${shortTask()} 결과를 요약하면, ${summarize(ev.result, 110)}. 자세한 내용은 보고함에서 확인하세요.`, "final");
      office?.focusFloor(3);
      finish();
      showTab("result");
      break;

    case "saved":
      run.savedToDb = true;
      dbReports = null; // 다음에 보고함을 열 때 새로 불러온다
      addEntry({ kind: "notice", icon: "🗄️", html: "공용 보고함(DB)에 저장했습니다. 다른 기기에서도 볼 수 있어요." });
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

// 본부장이 한 번에 나눠 준 업무를 묶어서 알린다 ("분배 단계 완료")
function announceRound() {
  if (!run.round.length || run.status !== "running") return;
  const names = run.round.map((id) => {
    const d = agents.get(id).def;
    return d.lead === "manager" && d.reports.length ? d.teamName : d.role;
  });
  run.round = [];
  announce(`본부장이 업무 분배를 마쳤습니다. ${names.join(", ")}에 일을 맡겼어요.`);
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

// 한 캐릭터의 이동은 Office3D가 순서대로(큐) 처리한다. 다른 층이면 엘리베이터를 탄다.
function visit(fromId, toId, carry) {
  return office ? office.visit(fromId, toId, carry) : Promise.resolve();
}

function speak(a, kind, delta) {
  if (a.bubbleKind !== kind) a.bubbleText = "";
  a.bubbleText += delta;
  const text = a.bubbleText.replace(/[#*`>|_-]{1,}/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return;
  showBubble(a, kind, text.length > 110 ? "…" + text.slice(-110) : text);
  setActivity(a, (kind === "thinking" ? "💭 " : "✍️ ") + (text.length > 70 ? "…" + text.slice(-70) : text));
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
}

// ── 모니터링: 진척도 · 단계 · 지표 · 타임라인 ──
function computeProgress() {
  if (run.status === "idle") return 0;
  if (run.status === "done") return 100;
  let p = 3;
  if (run.stage >= 1) p = 8;
  if (run.stage >= 2) p = 12 + (76 * run.reports) / Math.max(run.delegations, EXPECTED_TASKS);
  if (run.stage >= 3) p = 92;
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
    ? `${modeLabel(run.mode)} · ${run.model} · ${clock(run.t0)} 시작${run.t1 ? ` · ${clock(run.t1)} ${RUN_LABEL[status]}` : ""}`
    : "아래 입력창에 업무를 적으면 본부장이 팀장들에게 일을 나누고, 팀장들이 다시 팀원에게 맡겨 협업을 시작합니다.";
  const hm = $("#heroMaterials");
  hm.hidden = !run.materials.length;
  hm.innerHTML = run.materials.map((m) => `<span>📎 ${escapeHtml(m.name)}</span>`).join("");
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
  $("#kpiSearch").textContent = `${run.reads} · ${run.searches}`;
  $("#kpiCost").textContent = costText();

  // 팀별 진행 수 (팀원이 받은 업무 중 끝낸 것)
  for (const [key, t] of teamEls) {
    const members = [...agents.values()].filter((x) => x.def.team === key);
    const got = members.reduce((s, x) => s + (x.def.id === "manager" ? 0 : x.calls.length), 0);
    const done = members.reduce((s, x) => s + (x.def.id === "manager" ? 0 : x.calls.filter((c) => c.done).length), 0);
    const active = members.filter((x) => !["idle", "done"].includes(x.state)).length;
    t.count.textContent = got ? `완료 ${done}/${got}${active ? ` · ${active}명 작업 중` : ""}` : `${members.length}명`;
  }
  // 층 버튼에 "일하는 중" 표시
  for (const btn of document.querySelectorAll("#floorSwitch button")) {
    const f = Number(btn.dataset.floor);
    const busy = status === "running" && [...agents.values()].some((x) => (f === 0 || x.def.floor === f) && ["thinking", "searching", "working"].includes(x.state));
    btn.querySelector(".busy").hidden = !busy;
  }

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
  const tick = ((step / span) * 100).toFixed(3);

  let rows = "";
  let team = null;
  for (const a of agents.values()) {
    if (a.def.team !== team) {
      team = a.def.team;
      const t = config.teams[team];
      rows += `<div class="g-team" style="--c:${t.color}">${t.floor}F · ${t.name}</div>`;
    }
    const segs = a.segs
      .map((s) => {
        const t1 = s.t1 ?? now;
        const w = ((t1 - s.t0) / span) * 100;
        return `<i class="g-seg${s.t1 ? "" : " open"}" data-state="${s.state}" style="left:${pct(s.t0)};width:${w.toFixed(3)}%" title="${STATE_LABEL[s.state]} · ${duration(t1 - s.t0)}"></i>`;
      })
      .join("");
    const marks = a.marks.map((m) => `<span class="g-mark" style="left:${pct(m.t)}" title="${escapeHtml(m.title)}">${m.icon}</span>`).join("");
    const isMember = a.def.lead && a.def.lead !== "manager";
    rows += `<div class="g-row${isMember ? " g-sub" : ""}" style="--c:${a.def.color}">
        <div class="g-who"><img src="${a.def.photo}" alt="" /><span>${a.def.name} · ${a.def.role}</span></div>
        <div class="g-track" style="--tick:${tick}%">${segs}${marks}</div>
      </div>`;
  }
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
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(md || ""));
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

// ── 다시 보기: 저장된 작업 기록(타임라인)을 모니터링·타워에 재생한다 ──
// 실제 걸린 시간이 길면 45초 안에 끝나도록 빠르게 돌린다.
function replayReport(r) {
  if (controller) return alert("진행 중인 작업이 끝난 뒤에 다시 보기를 할 수 있어요.");
  const tl = r.timeline || [];
  const total = Math.max(1000, tl.at(-1)?.t || 1000);
  const speed = Math.max(1, total / 45000);
  resetRun();
  run.replay = true;
  setBusy(true);
  $("#submitBtn").textContent = `다시 보는 중 (×${Math.round(speed)})`;
  controller = { abort: stopReplay };
  location.hash = "#/monitor";
  let seq = 0;
  handle({ seq: seq++, type: "job_started", id: r.id, task: r.task, mode: r.mode, model: `${r.model} · 다시 보기 ×${Math.round(speed)}`, materials: r.materials || [] });
  for (const e of tl) {
    const ev = { ...e, seq: 0 };
    if (e.type === "report" && ev.text === undefined) ev.text = `(보고 ${e.chars || 0}자 — 전문은 최종 결과 참고)`;
    if (e.type === "delegate" && ev.instruction === undefined) ev.instruction = "(지시 내용은 저장되지 않았어요)";
    replayTimers.push(setTimeout(() => handle({ ...ev, seq: seq++ }), e.t / speed));
  }
  replayTimers.push(setTimeout(() => handle({ seq: seq++, type: "job_done", result: r.result || "", totalCost: r.cost || 0 }), total / speed + 800));
}

function stopReplay() {
  replayTimers.forEach(clearTimeout);
  replayTimers = [];
  endRun("cancelled");
  addEntry({ kind: "error", icon: "⏹️", html: "다시 보기를 멈췄습니다." });
  finish();
}

// ── 보고함: 이 브라우저(로컬) + 공용(Neon DB) ──
function loadLocalReports() {
  try {
    return JSON.parse(localStorage.getItem(REPORTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function storeLocalReports(list) {
  try {
    localStorage.setItem(REPORTS_KEY, JSON.stringify(list.slice(0, 30)));
    return true;
  } catch {
    return false;
  }
}

function saveLocalReport() {
  const report = {
    id: run.jobId || String(run.t0),
    task: run.task,
    mode: run.mode,
    model: run.model,
    startedAt: run.t0,
    durationMs: run.t1 - run.t0,
    cost: run.cost,
    costDemo: run.costDemo,
    delegations: run.delegations,
    searches: run.searches,
    materials: run.materials,
    result: run.result,
    source: "local",
  };
  const list = loadLocalReports().filter((r) => r.id !== report.id);
  list.unshift(report);
  storeLocalReports(list);
  selectedReport = report.id;
  renderReportList();
}

async function dbFetch(path, opts = {}) {
  const code = getPasscode();
  if (!code) throw new Error("접속 코드가 필요해요.");
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), "X-Office-Passcode": code } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code === "bad_passcode") forgetPasscode();
    throw new Error(data.error || "공용 보고함을 불러오지 못했습니다.");
  }
  return data;
}

async function loadDbReports() {
  if (!config?.dbAvailable) return;
  try {
    dbReports = (await dbFetch("/api/reports")).reports;
  } catch (err) {
    dbReports = [];
    $("#reportList").insertAdjacentHTML("afterbegin", `<p class="empty" style="color:var(--s-error)">${escapeHtml(err.message)}</p>`);
    return;
  }
  renderReportList();
}

// 공용(DB) 보고서를 우선으로, 같은 작업이 로컬에도 있으면 하나로 합친다
function mergedReports() {
  const local = loadLocalReports();
  const db = dbReports || [];
  const ids = new Set(db.map((r) => r.id));
  return [...db, ...local.filter((r) => !ids.has(r.id))].sort((a, b) => b.startedAt - a.startedAt);
}

function renderReportList() {
  const list = mergedReports();
  const count = $("#reportCount");
  count.hidden = !list.length;
  count.textContent = String(list.length);
  const box = $("#reportList");
  const dbNote = config?.dbAvailable ? `<p class="muted small" style="margin:0 0 10px">🗄️ 공용 보고함(DB) 연결됨 · 다른 기기에서도 같은 목록이 보여요</p>` : "";
  if (!list.length) {
    box.innerHTML = dbNote + `<p class="empty">아직 완료된 업무가 없어요. 업무를 지시하면 결과가 여기에 쌓입니다.</p>`;
    $("#reportDetail").innerHTML = `<p class="empty">왼쪽에서 보고서를 고르면 내용이 여기에 표시됩니다.</p>`;
    return;
  }
  if (!list.some((r) => r.id === selectedReport)) selectedReport = list[0].id;
  box.innerHTML = dbNote + list
    .map(
      (r) => `<button type="button" class="report-item${r.id === selectedReport ? " active" : ""}" data-id="${r.id}">
        <b>${escapeHtml(r.task)}</b>
        <span class="row"><span class="tag${r.mode === "demo" ? "" : " live"}">${modeLabel(r.mode)}</span>
        <span>${r.source === "db" ? "🗄️" : "💻"}</span>
        <span>${dateTime(r.startedAt)}</span><span>⏱ ${duration(r.durationMs)}</span><span>위임 ${r.delegations}건</span>${
          r.materials?.length ? `<span>📎 ${r.materials.length}</span>` : ""}</span>
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

async function renderReportDetail(r) {
  const el = $("#reportDetail");
  if (r.source === "db" && r.result === undefined) {
    el.innerHTML = `<p class="empty">불러오는 중…</p>`;
    try {
      Object.assign(r, await dbFetch(`/api/reports/${encodeURIComponent(r.id)}`));
    } catch (err) {
      el.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (selectedReport !== r.id) return;
  }
  el.innerHTML = `<div class="detail-head">
      <div>
        <h2>${escapeHtml(r.task)}</h2>
        <div class="muted small">${r.source === "db" ? "🗄️ 공용 보고함" : "💻 이 브라우저"} · ${modeLabel(r.mode)} · ${escapeHtml(r.model)} · ${dateTime(r.startedAt)} · 소요 ${duration(r.durationMs)} · 위임 ${r.delegations}건 · 검색 ${r.searches}회 · ${r.costDemo ? "~" : ""}$${(r.cost || 0).toFixed(3)}</div>
        ${r.materials?.length ? `<div class="hero-materials">${r.materials.map((m) => `<span>📎 ${escapeHtml(m.name)}</span>`).join("")}</div>` : ""}
      </div>
    </div>
    ${resultActions(r.result || "", `${r.timeline?.length ? ` <button type="button" class="btn-primary" data-act="replay">▶ 모니터링에서 다시 보기</button>` : ""} <button type="button" class="btn-ghost" data-act="again">같은 업무 다시 지시</button> <button type="button" class="btn-ghost" data-act="delete">삭제</button>`)}
    <div class="markdown">${renderMarkdown(r.result)}</div>`;
  wireResultActions(el, r.result || "", "AI사무실_" + r.task.slice(0, 20).replace(/[\\/:*?"<>|\s]+/g, "_"));
  el.querySelector('[data-act="replay"]')?.addEventListener("click", () => replayReport(r));
  el.querySelector('[data-act="again"]').addEventListener("click", () => {
    $("#task").value = r.task;
    autoGrow();
    $("#task").focus();
  });
  el.querySelector('[data-act="delete"]').addEventListener("click", async () => {
    if (!confirm(r.source === "db" ? "공용 보고함에서 삭제할까요? 모든 기기에서 사라집니다." : "이 보고서를 보고함에서 삭제할까요?")) return;
    try {
      if (r.source === "db") {
        await dbFetch(`/api/reports/${encodeURIComponent(r.id)}`, { method: "DELETE" });
        dbReports = (dbReports || []).filter((x) => x.id !== r.id);
      }
    } catch (err) {
      return alert(err.message);
    }
    storeLocalReports(loadLocalReports().filter((x) => x.id !== r.id));
    selectedReport = null;
    renderReportList();
  });
}

// ── 사람 상세 창 ──────────────────────────
function openAgentDialog(id) {
  const a = agents.get(id);
  const d = a.def;
  const boss = d.lead ? agents.get(d.lead).def : null;
  const team = d.reports.map((x) => agents.get(x).def.name).join(", ");
  $("#dialogTitle").innerHTML = `<div class="profile">
      <img class="profile-photo" src="${d.photo}" alt="${d.name} 프로필 사진" style="--c:${d.color}" />
      <div>
        <div class="title">${d.name} ${d.title} <span class="role-tag" style="--c:${d.color}">${d.floor}F ${d.teamName} · ${d.role}</span></div>
        <div class="sub">${d.age}세 · ${escapeHtml(d.career)}</div>
        <div class="sub">${escapeHtml(d.personality)}</div>
        <div class="sub">${boss ? `상사: ${boss.name} ${boss.title}` : "최상위 책임자"}${team ? ` · 팀원: ${team}` : ""}</div>
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
          <h4>${id === "manager" ? "받은 요청" : `업무 ${i + 1} · ${boss ? boss.name : ""} 지시`}</h4>
          <div class="instruction">${escapeHtml(c.instruction)}</div>
          ${c.reads?.length ? `<p class="thought">📚 ${c.reads.map(escapeHtml).join(" · ")}</p>` : ""}
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
