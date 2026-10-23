// AIINTERSYS AI TOWER: 실제 프로젝트·사람·구글 캘린더 일정을 모니터링 화면과 3D 타워로 보여 준다.
// 화면: #/monitor(첫 화면) · #/office(타워) · #/reports(보고함)

import { announce, unlock, isVoiceEnabled, setVoiceEnabled } from "./voice.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 86_400_000;
const CODE_KEY = "aiTower.passcode";
const WD = ["일", "월", "화", "수", "목", "금", "토"];

const S = {
  code: readCode(),
  data: null,
  events: [],
  projects: [],
  byId: {},
  people: {},
  virtual: null, // 타워에서 보는 시각 (null = 지금)
  weekShift: 0,
  announced: new Set(),
  reports: null,
  selectedReport: null,
  chat: { messages: [], insights: null, days: null, error: null, loading: false },
  replay: null,
};
let office = null;
let officeLoading = null;

// ── 시간 도우미 (한국 시간 기준) ──
const KST = 9 * 3_600_000;
const kst = (ms) => new Date(ms + KST); // UTC 필드 = 한국 시각
const ymdK = (ms) => kst(ms).toISOString().slice(0, 10);
const startOfDayK = (ms) => Math.floor((ms + KST) / DAY) * DAY - KST;
const hm = (ms) => kst(ms).toISOString().slice(11, 16);
const md = (ms) => { const d = kst(ms); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const wd = (ms) => WD[kst(ms).getUTCDay()];
const dDay = (ms, now) => { const n = Math.round((startOfDayK(ms) - startOfDayK(now)) / DAY); return n === 0 ? "오늘" : n > 0 ? `D-${n}` : `D+${-n}`; };
function whenText(e) {
  if (e.allDay) {
    const days = Math.round((e.endMs - e.startMs) / DAY);
    return days > 1 ? `${md(e.startMs)}(${wd(e.startMs)}) ~ ${md(e.endMs - DAY)}(${wd(e.endMs - DAY)}) · 종일` : `${md(e.startMs)}(${wd(e.startMs)}) 종일`;
  }
  return `${md(e.startMs)}(${wd(e.startMs)}) ${hm(e.startMs)}–${hm(e.endMs)}`;
}

function readCode() {
  try { return localStorage.getItem(CODE_KEY) || ""; } catch { return ""; }
}
function saveCode(c) {
  S.code = c;
  try { c ? localStorage.setItem(CODE_KEY, c) : localStorage.removeItem(CODE_KEY); } catch {}
}

// 이름 첫 글자 아바타
function avatar(person, size = 64) {
  const label = person.name.slice(-2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="${person.color}"/><text x="32" y="41" text-anchor="middle" font-family="Pretendard,'Malgun Gothic',sans-serif" font-size="24" font-weight="800" fill="#fff">${label}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

// ── 서버 ──
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), "X-Office-Passcode": S.code } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const err = new Error(data.error || "접속 코드가 맞지 않아요.");
    err.locked = true;
    throw err;
  }
  if (!res.ok) throw new Error(data.error || "서버 오류가 났어요.");
  return data;
}

async function load() {
  const data = await api("/api/office");
  S.data = data;
  S.projects = [...data.projects].sort((a, b) => b.floor - a.floor);
  S.byId = Object.fromEntries(S.projects.map((p) => [p.id, p]));
  S.people = data.people;
  for (const p of Object.values(S.people)) p.photo = avatar(p);
  S.events = data.calendar.events
    .map((e) => ({
      ...e,
      startMs: e.allDay ? Date.parse(e.start + "T00:00:00+09:00") : Date.parse(e.start),
      endMs: e.allDay ? Date.parse(e.end + "T00:00:00+09:00") : Date.parse(e.end),
    }))
    .filter((e) => S.byId[e.project] && !Number.isNaN(e.startMs))
    .sort((a, b) => a.startMs - b.startMs);
  S.calEvents = S.events;
  mergeDeadlines();
}

// 단톡방에서 뽑은 마감일을 KRISO 일정으로 함께 보여 준다
function mergeDeadlines() {
  const ins = S.chat.insights;
  const extra = (ins?.deadlines || [])
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date || ""))
    .map((d, i) => {
      const start = Date.parse(d.date + "T00:00:00+09:00");
      return { id: `chat-deadline-${i}`, project: "kriso", title: `[마감] ${d.title}`, description: `${d.note || ""}\n(단톡방 ${String(d.from || "").replace("T", " ")} 대화에서 정리)`, location: "", allDay: true, start: d.date, startMs: start, endMs: start + DAY, people: ["yang", "shin", "leebu", "leejh"], deadline: true };
    });
  S.events = [...(S.calEvents || []), ...extra].sort((a, b) => a.startMs - b.startMs);
}

// ── 잠금 ──
function showLock(message) {
  $("#app").hidden = true;
  $("#lock").hidden = false;
  $("#lockError").hidden = !message;
  $("#lockError").textContent = message || "";
  setTimeout(() => $("#lockCode").focus(), 50);
}
$("#lockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  unlock();
  saveCode($("#lockCode").value.trim());
  $("#lockForm button").disabled = true;
  try {
    await start();
  } finally {
    $("#lockForm button").disabled = false;
  }
});

async function start() {
  try {
    await load();
  } catch (err) {
    if (err.locked) {
      saveCode("");
      return showLock(S.code === "" && !$("#lockCode").value ? "" : "접속 코드가 맞지 않아요.");
    }
    return showLock(err.message);
  }
  $("#lock").hidden = true;
  $("#app").hidden = false;
  renderAll();
  route();
  loadChat();
}

// ── 일정 계산 ──
const now = () => Date.now();
function projectStats(p, t = now()) {
  const evs = S.events.filter((e) => e.project === p.id);
  const done = evs.filter((e) => e.endMs <= t);
  const current = evs.filter((e) => e.startMs <= t && t < e.endMs);
  const next = evs.find((e) => e.startMs > t);
  let status = "none";
  if (current.length) status = "now";
  else if (next) status = next.startMs - t < 7 * DAY ? "soon" : "planned";
  else if (done.length) status = "waiting";
  return { evs, done, current, next, last: done.at(-1), status };
}
const STATUS_TEXT = { now: "진행 중", soon: "이번 주 일정", planned: "예정", waiting: "다음 일정 미정", none: "일정 없음" };

// 사람이 시각 t에 어디 있는가: 진행 중인 일정의 층, 없으면 자기 자리(가장 위층 배정)
function whereIs(personId, t) {
  const ev = S.events.find((e) => !e.deadline && e.people.includes(personId) && e.startMs <= t && t < e.endMs);
  const homeProject = S.projects.find((p) => p.members.some((m) => m.id === personId));
  if (ev) {
    const p = S.byId[ev.project];
    const kriso = p.id === "kriso";
    const slot = kriso ? p.members.findIndex((m) => m.id === personId) : 0;
    return { floor: p.floor, kind: kriso ? "meeting" : p.group ? "lecture" : "meeting", slot: Math.max(0, slot), event: ev, project: p };
  }
  return { floor: homeProject.floor, kind: "desk", slot: 0, event: null, project: homeProject };
}
function roleOn(personId, p) {
  return p.members.find((m) => m.id === personId);
}

// ── 그리기 ──
function renderAll() {
  renderClock();
  renderCalPill();
  renderHero();
  renderKpis();
  renderProjects();
  renderTimeline();
  renderUpcoming();
  renderPeople();
  renderCalHelp();
  syncOffice(false);
}

function renderClock() {
  const t = now();
  $("#clock").textContent = `${md(t)}(${wd(t)}) ${hm(t)}`;
}

function renderCalPill() {
  const c = S.data.calendar;
  const pill = $("#calPill");
  pill.dataset.source = c.error ? "error" : c.source;
  const when = c.syncedAt ? `${md(Date.parse(c.syncedAt))} ${hm(Date.parse(c.syncedAt))}` : "";
  $("#calText").textContent = c.source === "ical" ? (c.error ? "캘린더 연결 오류" : "구글 캘린더 실시간") : c.source === "db" ? `캘린더 동기화 ${when}` : "캘린더 없음";
  pill.title = c.error || (c.source === "ical" ? `구글 캘린더에서 읽음 (${when})` : "구글 캘린더 iCal 주소를 연결하면 실시간으로 바뀌어요");
}

function renderHero() {
  const t = now();
  const shin = S.people.shin;
  const cur = S.events.filter((e) => e.people.includes("shin") && e.startMs <= t && t < e.endMs);
  const next = S.events.find((e) => e.people.includes("shin") && e.startMs > t);
  const hero = $("#hero");
  if (cur.length) {
    const e = cur[0];
    const p = S.byId[e.project];
    hero.style.setProperty("--c", p.color);
    $("#heroEyebrow").textContent = "지금 진행 중";
    $("#heroTitle").textContent = e.title;
    $("#heroMeta").innerHTML = `${esc(whenText(e))} · <b>${p.floor}F ${esc(p.short)}</b> · ${esc(shin.name)} ${esc(roleOn("shin", p)?.role || "")}${e.location ? ` · 📍 ${esc(e.location)}` : ""}`;
  } else if (next) {
    const p = S.byId[next.project];
    hero.style.setProperty("--c", p.color);
    $("#heroEyebrow").textContent = `다음 일정 · ${dDay(next.startMs, t)}`;
    $("#heroTitle").textContent = next.title;
    $("#heroMeta").innerHTML = `${esc(whenText(next))} · <b>${p.floor}F ${esc(p.short)}</b>${next.location ? ` · 📍 ${esc(next.location)}` : ""} · 지금 ${esc(shin.name)}은 ${whereIs("shin", t).floor}F 자리`;
  } else {
    hero.style.removeProperty("--c");
    $("#heroEyebrow").textContent = "지금";
    $("#heroTitle").textContent = "예정된 프로젝트 일정이 없어요";
    $("#heroMeta").textContent = "구글 캘린더에 프로젝트 이름(KRISO, 한국몰드, 탑아이앤디, DnK모빌리티, 소상공인)이 들어간 일정을 넣으면 여기 나타나요.";
  }
  const target = cur[0] || next;
  $("#heroActions").innerHTML = target ? `<button type="button" class="btn-primary" data-goto="${esc(target.id)}">타워에서 보기</button> <button type="button" class="btn-ghost" data-event="${esc(target.id)}">일정 자세히</button>` : "";
}

function renderKpis() {
  const t = now();
  const sow = startOfDayK(t) - ((kst(t).getUTCDay() + 6) % 7) * DAY; // 이번 주 월요일
  const week = S.events.filter((e) => e.startMs >= sow && e.startMs < sow + 7 * DAY);
  const doneAll = S.events.filter((e) => e.endMs <= t).length;
  const active = S.projects.filter((p) => ["now", "soon", "planned"].includes(projectStats(p, t).status)).length;
  const next = S.events.find((e) => e.startMs > t);
  $("#kpis").innerHTML = [
    ["진행 프로젝트", `${active}<small> / ${S.projects.length}</small>`, "다가오는 일정이 있는 프로젝트"],
    ["이번 주 일정", `${week.length}<small>건</small>`, `${md(sow)} ~ ${md(sow + 6 * DAY)}`],
    ["다음 일정", next ? dDay(next.startMs, t) : "—", next ? `${S.byId[next.project].short} · ${md(next.startMs)} ${next.allDay ? "종일" : hm(next.startMs)}` : "예정 없음"],
    ["일정 진행", S.events.length ? `${doneAll}<small> / ${S.events.length}</small>` : "—", "캘린더 기준 지난 일정 / 전체"],
  ].map(([k, v, m]) => `<div class="kpi"><span>${k}</span><b>${v}</b><em>${esc(m)}</em></div>`).join("");
}

function renderProjects() {
  const t = now();
  $("#projects").innerHTML = S.projects.map((p) => {
    const st = projectStats(p, t);
    const pct = st.evs.length ? Math.round((st.done.length / st.evs.length) * 100) : 0;
    const members = p.members.map((m) => {
      const person = S.people[m.id];
      return `<button type="button" class="member" data-person="${m.id}" style="--c:${person.color}"><img src="${person.photo}" alt="" /><span><b>${esc(person.name)}</b> <small>${esc(m.role)}${m.duty ? " · " + esc(m.duty) : ""}</small></span></button>`;
    }).join("");
    const nextLine = st.current.length
      ? `<span class="chip-s now">지금</span> ${esc(st.current[0].title)}`
      : st.next ? `<span class="chip-s">${dDay(st.next.startMs, t)}</span> ${esc(whenText(st.next))}` : `<span class="muted">${st.last ? `마지막 일정 ${esc(whenText(st.last))}` : "캘린더에 아직 일정이 없어요"}</span>`;
    return `<article class="project" style="--c:${p.color}">
      <header>
        <span class="floor-badge">${p.floor}F</span>
        <div class="p-title"><h3>${esc(p.name)}</h3><small>${esc(p.group || p.summary || "")}</small></div>
        <span class="p-status" data-status="${st.status}">${STATUS_TEXT[st.status]}</span>
      </header>
      ${p.title ? `<p class="p-task">${esc(p.title)}</p>` : `<p class="p-task muted">세부 과제 내용은 아직 등록되지 않았어요.</p>`}
      ${p.tags ? `<div class="p-tags">${p.tags.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}
      <div class="members">${members}</div>
      <div class="p-progress"><div class="bar"><i style="width:${pct}%"></i></div><small>일정 ${st.done.length}/${st.evs.length}</small></div>
      <div class="p-next">${nextLine}</div>
      ${p.strategies ? `<details><summary>AX 실행계획 전략 ${p.strategies.length}개${p.partner ? ` · 참여기업 ${esc(p.partner)}` : ""}</summary><ol>${p.strategies.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>${p.day ? `<p class="small muted">${esc(p.summary)} · ${esc(p.day)}</p>` : ""}</details>` : ""}
      <button type="button" class="link-btn" data-floor="${p.floor}">타워 ${p.floor}층 보기 →</button>
    </article>`;
  }).join("");
}

function renderTimeline() {
  const t = now();
  const today = startOfDayK(t);
  const monday = today - ((kst(t).getUTCDay() + 6) % 7) * DAY;
  const from = monday - 7 * DAY + S.weekShift * DAY;
  const days = 42;
  const cols = Array.from({ length: days }, (_, i) => from + i * DAY);
  const head = cols.map((d) => {
    const k = kst(d), dow = k.getUTCDay(), isToday = d === today;
    const label = dow === 1 || d === from ? `${k.getUTCMonth() + 1}/${k.getUTCDate()}` : "";
    return `<div class="tl-h${dow === 0 || dow === 6 ? " we" : ""}${isToday ? " today" : ""}" title="${md(d)}(${WD[dow]})">${label}<i>${WD[dow]}</i></div>`;
  }).join("");
  const rows = S.projects.map((p) => {
    const cells = cols.map((d) => {
      const evs = S.events.filter((e) => e.project === p.id && e.startMs < d + DAY && e.endMs > d);
      const k = kst(d), dow = k.getUTCDay();
      const cls = `tl-c${dow === 0 || dow === 6 ? " we" : ""}${d === today ? " today" : ""}${evs.length ? " has" : ""}${evs.length && evs.every((e) => e.endMs <= t) ? " past" : ""}`;
      return evs.length
        ? `<button type="button" class="${cls}" style="--c:${p.color}" data-event="${esc(evs[0].id)}" title="${esc(evs.map((e) => `${whenText(e)} ${e.title}`).join("\n"))}"><span>${evs[0].allDay ? "종일" : String(kst(evs[0].startMs).getUTCHours())}</span></button>`
        : `<div class="${cls}"></div>`;
    }).join("");
    return `<div class="tl-who" style="--c:${p.color}"><b>${p.floor}F</b> ${esc(p.short)}</div>${cells}`;
  }).join("");
  $("#timeline").style.setProperty("--days", days);
  $("#timeline").innerHTML = `<div class="tl-who tl-corner">${md(from)} ~ ${md(from + (days - 1) * DAY)}</div>${head}${rows}`;
}

function renderUpcoming() {
  const t = now();
  const list = S.events.filter((e) => e.endMs > t && e.startMs < t + 14 * DAY);
  if (!list.length) {
    $("#upcoming").innerHTML = `<p class="empty">앞으로 2주 동안 프로젝트 일정이 없어요.</p>`;
    return;
  }
  let lastDay = "";
  $("#upcoming").innerHTML = list.map((e) => {
    const p = S.byId[e.project];
    const day = ymdK(e.startMs);
    const head = day !== lastDay ? `<div class="up-day"><b>${md(e.startMs)}(${wd(e.startMs)})</b> <span>${dDay(e.startMs, t)}</span></div>` : "";
    lastDay = day;
    const live = e.startMs <= t && t < e.endMs;
    return `${head}<button type="button" class="up-item${live ? " live" : ""}" data-event="${esc(e.id)}" style="--c:${p.color}">
      <span class="up-time">${e.allDay ? "종일" : `${hm(e.startMs)}<small>${hm(e.endMs)}</small>`}</span>
      <span class="up-body"><b>${esc(e.title)}</b><small>${p.floor}F ${esc(p.short)} · ${e.people.map((id) => esc(S.people[id]?.name)).join(", ")}</small></span>
    </button>`;
  }).join("");
}

function renderPeople() {
  const t = now();
  const people = Object.values(S.people);
  $("#peopleCount").textContent = `${people.length}명`;
  $("#people").innerHTML = people.map((person) => {
    const assigned = S.projects.filter((p) => p.members.some((m) => m.id === person.id));
    const w = whereIs(person.id, t);
    const state = w.event ? `<span class="state-chip" data-state="meeting"><i class="state-dot" data-state="meeting"></i>${w.floor}F ${esc(w.project.short)} 일정 중</span>` : `<span class="state-chip" data-state="present"><i class="state-dot" data-state="present"></i>${w.floor}F 자리</span>`;
    return `<button type="button" class="person-card" data-person="${person.id}" style="--c:${person.color}">
      <img src="${person.photo}" alt="" />
      <span class="pc-main"><b>${esc(person.name)}</b> ${state}
        <small>${assigned.map((p) => `${esc(p.short)} ${esc(roleOn(person.id, p).role)}`).join(" · ")}</small></span>
    </button>`;
  }).join("");
}

function renderCalHelp() {
  const c = S.data.calendar;
  const box = $("#calHelp");
  box.hidden = c.source === "ical" && !c.error;
  if (box.hidden) return;
  box.innerHTML = `<div class="card-head"><h2>구글 캘린더 실시간 연결</h2></div>
    <p class="small">${c.error ? `⚠️ ${esc(c.error)}` : "지금은 지피가 동기화해 둔 일정을 보여 주고 있어요."} 아래처럼 연결하면 캘린더를 바꾸는 즉시 반영돼요.</p>
    <ol class="small help-steps">
      <li>컴퓨터에서 구글 캘린더 → ⚙️ 설정</li>
      <li>왼쪽 '내 캘린더의 설정'에서 <b>sdw1621@gmail.com</b> 선택</li>
      <li>'캘린더 통합' → <b>iCal 형식의 비공개 주소</b> 복사</li>
      <li>지피에게 주소를 주면 Vercel에 <code>GCAL_ICS_URL</code>로 넣고 다시 배포해요</li>
    </ol>
    <p class="small muted">프로젝트 이름이 들어간 일정만 화면에 나오고, 개인 일정은 서버 밖으로 나가지 않아요.</p>`;
}

// ── 일정 자세히 ──
function openEvent(id) {
  const e = S.events.find((x) => x.id === id);
  if (!e) return;
  const p = S.byId[e.project];
  const t = now();
  const state = e.endMs <= t ? "지난 일정" : e.startMs <= t ? "진행 중" : dDay(e.startMs, t);
  openDialog(
    `<div class="title">${esc(e.title)}</div><div class="sub">${esc(whenText(e))} · ${state}</div>`,
    `<div class="ev-detail" style="--c:${p.color}">
      <p><span class="floor-badge">${p.floor}F</span> <b>${esc(p.name)}</b> ${p.title ? `<br><small class="muted">${esc(p.title)}</small>` : ""}</p>
      ${e.location ? `<p>📍 ${esc(e.location)}</p>` : ""}
      <p>참석: ${e.people.map((pid) => `${esc(S.people[pid].name)} ${esc(roleOn(pid, p)?.role || "")}`).join(", ")}</p>
      ${e.description ? `<pre class="ev-desc">${esc(e.description)}</pre>` : ""}
      <div class="detail-actions"><button type="button" class="btn-primary" data-goto="${esc(e.id)}">이 시각의 타워 보기</button></div>
    </div>`,
  );
}

function openPerson(id) {
  const person = S.people[id];
  const t = now();
  const assigned = S.projects.filter((p) => p.members.some((m) => m.id === id));
  const upcoming = S.events.filter((e) => e.people.includes(id) && e.endMs > t).slice(0, 6);
  const w = whereIs(id, t);
  openDialog(
    `<div class="profile" style="--c:${person.color}"><img class="profile-photo" src="${person.photo}" alt="" /><div><div class="title"><b>${esc(person.name)}</b> <span class="role-tag">${esc(person.title)}</span></div><div class="sub">지금: ${w.event ? `${w.floor}F ${esc(w.project.short)} — ${esc(w.event.title)}` : `${w.floor}F ${esc(w.project.short)} 자리`}</div></div></div>`,
    `<h4 class="dlg-h">배정 프로젝트</h4><ul class="assign">${assigned.map((p) => { const m = roleOn(id, p); return `<li style="--c:${p.color}"><span class="floor-badge">${p.floor}F</span> <b>${esc(p.name)}</b> — ${esc(m.role)}${m.duty ? ` · ${esc(m.duty)}` : ""}</li>`; }).join("")}</ul>
     <h4 class="dlg-h">다가오는 일정</h4>${upcoming.length ? `<ul class="assign">${upcoming.map((e) => `<li style="--c:${S.byId[e.project].color}"><button type="button" class="link-btn" data-event="${esc(e.id)}">${esc(whenText(e))} · ${esc(e.title)}</button></li>`).join("")}</ul>` : `<p class="empty">예정된 일정이 없어요.</p>`}`,
  );
}

function openDialog(title, body) {
  $("#dialogTitle").innerHTML = title;
  $("#dialogBody").innerHTML = body;
  const d = $("#dialog");
  if (!d.open) d.showModal();
}
$("#dialogClose").addEventListener("click", () => $("#dialog").close());
$("#dialog").addEventListener("click", (e) => { if (e.target.id === "dialog") e.target.close(); });

// 위임: 화면 어디서든 data-* 버튼
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-event],[data-person],[data-goto],[data-floor],[data-shift]");
  if (!b || b.closest(".floor-switch")) return;
  if (b.dataset.goto) {
    $("#dialog").open && $("#dialog").close();
    return gotoEvent(b.dataset.goto);
  }
  if (b.dataset.event) return openEvent(b.dataset.event);
  if (b.dataset.person) return openPerson(b.dataset.person);
  if (b.dataset.floor) {
    location.hash = "#/office";
    ensureOffice().then(() => office?.focusFloor(Number(b.dataset.floor)));
    return;
  }
  if (b.dataset.shift !== undefined) {
    const v = Number(b.dataset.shift);
    S.weekShift = v === 0 ? 0 : S.weekShift + v;
    renderTimeline();
  }
});

// ── 3D 타워 ──
function ensureOffice() {
  if (office) return Promise.resolve(office);
  if (officeLoading) return officeLoading;
  officeLoading = import("./office3d.js")
    .then(({ Office3D }) => {
      office = new Office3D($("#office3d"), {
        projects: S.projects,
        onSelect: (id) => openPerson(id),
        onFloor: paintFloorButtons,
      });
      for (const person of Object.values(S.people)) {
        const seats = S.projects
          .filter((p) => p.members.some((m) => m.id === person.id))
          .map((p) => { const m = roleOn(person.id, p); return { floor: p.floor, desk: m.desk, role: m.role, color: p.color }; });
        const home = whereIs(person.id, -Infinity);
        office.addPerson({ ...person, title: person.title }, seats, home.floor);
      }
      office.finishBuild();
      buildFloorButtons();
      syncOffice(true);
      setupReplay();
      return office;
    })
    .catch((err) => {
      console.error(err);
      $("#office3d").insertAdjacentHTML("beforeend", `<p class="office-error">3D 화면을 불러오지 못했어요: ${esc(err.message)}</p>`);
    });
  return officeLoading;
}

function buildFloorButtons() {
  const el = $("#floorSwitch");
  el.innerHTML = `<button type="button" data-f="0">전체 타워</button>` + S.projects.map((p) => `<button type="button" data-f="${p.floor}" style="--c:${p.color}"><i class="fdot"></i>${p.floor}F ${esc(p.short)}<span class="busy" hidden></span></button>`).join("");
  el.onclick = (e) => {
    const b = e.target.closest("[data-f]");
    if (b) office?.focusFloor(Number(b.dataset.f));
  };
  paintFloorButtons(office?.focus ?? 0);
}
function paintFloorButtons(n) {
  for (const b of $$("#floorSwitch [data-f]")) b.classList.toggle("active", Number(b.dataset.f) === n);
}

// 시각 t(기본: 지금)에 맞춰 사람들을 옮긴다
function syncOffice(instant) {
  if (!office || S.replay) return;
  const t = S.virtual ?? now();
  const moves = [];
  for (const id of Object.keys(S.people)) {
    const w = whereIs(id, t);
    const from = office.floorOfPerson(id);
    const p = w.project;
    const m = roleOn(id, p);
    office.setLabel(id, `${p.short} ${m?.role || ""}`.trim());
    const job = office.moveTo(id, { floor: w.floor, kind: w.kind, slot: w.slot }, { instant });
    if (!instant && from !== w.floor) {
      office.setState(id, "moving");
      if ($("#followMove").checked) office.focusFloor(from);
      moves.push({ id, to: w.floor });
    }
    job.then(() => {
      office.setState(id, w.event ? "meeting" : "present");
      if (w.event) office.showBubble(id, "say", w.event.title.replace(/^\[[^\]]+\]\s*/, ""));
      else office.hideBubble(id);
      if (!instant && from !== w.floor && $("#followMove").checked) office.focusFloor(w.floor);
    });
  }
  // 상태 표시
  const shin = whereIs("shin", t);
  $("#officeWhen").textContent = S.virtual ? `${md(t)}(${wd(t)}) ${hm(t)}` : "지금";
  $("#officeWhat").textContent = shin.event ? `${S.people.shin.name} → ${shin.floor}F ${shin.project.short} · ${shin.event.title}` : `${S.people.shin.name} ${shin.floor}F 자리 · 진행 중인 일정 없음`;
  $("#officeNow").hidden = !S.virtual;
  for (const b of $$("#floorSwitch [data-f]")) {
    const f = Number(b.dataset.f);
    const busy = S.events.some((e) => S.byId[e.project].floor === f && e.startMs <= t && t < e.endMs);
    const dot = b.querySelector(".busy");
    if (dot) dot.hidden = !busy;
  }
  return moves;
}

async function gotoEvent(id) {
  const e = S.events.find((x) => x.id === id);
  if (!e) return;
  location.hash = "#/office";
  await ensureOffice();
  if (!office) return;
  S.virtual = e.allDay ? e.startMs + 10 * 3_600_000 : e.startMs + Math.min(30 * 60_000, (e.endMs - e.startMs) / 2);
  const moves = syncOffice(false);
  const p = S.byId[e.project];
  if (!moves.length) office.focusFloor(p.floor);
  if (isVoiceEnabled()) {
    unlock();
    announce(`${md(e.startMs).replace("/", "월 ")}일 ${e.allDay ? "" : hm(e.startMs).replace(":", "시 ") + "분, "}${p.floor}층 ${p.short} 일정입니다. ${e.title.replace(/[\[\]]/g, " ")}`, "step");
  }
}
$("#officeNow").addEventListener("click", () => {
  S.virtual = null;
  syncOffice(false);
});
$$("[data-cam]").forEach((b) => b.addEventListener("click", () => office?.resetView(b.dataset.cam)));
$("#autoRotate").addEventListener("change", (e) => office?.setAutoRotate(e.target.checked));

// ── 보고함 ──
async function loadReports() {
  if (S.reports) return renderReportList();
  try {
    S.reports = (await api("/api/reports")).reports;
  } catch (err) {
    $("#reportList").innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    return;
  }
  renderReportList();
}
function renderReportList() {
  const list = S.reports || [];
  $("#reportCount").hidden = !list.length;
  $("#reportCount").textContent = list.length;
  $("#reportList").innerHTML = list.length
    ? list.map((r) => `<button type="button" class="report-item${S.selectedReport === r.id ? " active" : ""}" data-report="${esc(r.id)}"><b>${esc(r.task)}</b><span class="row"><span>${md(r.startedAt)} ${hm(r.startedAt)}</span>${r.materials?.length ? `<span>📎 ${r.materials.length}</span>` : ""}</span></button>`).join("")
    : `<p class="empty">아직 보고서가 없어요.</p>`;
}
$("#reportList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-report]");
  if (!b) return;
  S.selectedReport = b.dataset.report;
  renderReportList();
  const box = $("#reportDetail");
  box.innerHTML = `<p class="empty">불러오는 중…</p>`;
  try {
    const r = await api(`/api/reports/${encodeURIComponent(S.selectedReport)}`);
    const html = window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(r.result || "")) : `<pre>${esc(r.result)}</pre>`;
    box.innerHTML = `<div class="detail-head"><div><h2>${esc(r.task)}</h2><div class="small muted">${md(r.startedAt)} ${hm(r.startedAt)}${r.materials?.length ? ` · 자료 ${r.materials.map((m) => esc(m.name)).join(", ")}` : ""}</div></div>
      <div class="detail-actions"><button type="button" class="btn-ghost" id="copyReport">복사</button></div></div>${html}`;
    $("#copyReport").onclick = async (ev) => {
      try { await navigator.clipboard.writeText(r.result || ""); ev.target.textContent = "복사됨 ✓"; } catch { ev.target.textContent = "복사 안 됨"; }
    };
  } catch (err) {
    box.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
});

// ── 음성 알림: 일정 10분 전 · 시작 ──
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
      announce("음성 알림을 켰어요. 일정 시작 10분 전과 시작할 때 알려 드릴게요.");
    }
  });
  paint();
  document.addEventListener("pointerdown", () => unlock(), { once: true });
}
function checkReminders() {
  if (!S.events.length) return;
  const t = now();
  for (const e of S.events) {
    if (e.allDay) continue;
    const p = S.byId[e.project];
    const name = e.title.replace(/[\[\]]/g, " ");
    if (e.startMs - t <= 10 * 60_000 && e.startMs - t > 9 * 60_000 && !S.announced.has(e.id + "-10")) {
      S.announced.add(e.id + "-10");
      if (isVoiceEnabled()) announce(`10분 뒤 ${p.short} 일정이 시작돼요. ${name}`, "step");
    }
    if (t >= e.startMs && t - e.startMs < 60_000 && !S.announced.has(e.id + "-0")) {
      S.announced.add(e.id + "-0");
      if (isVoiceEnabled()) announce(`지금 ${p.floor}층 ${p.short} 일정이 시작됐어요. ${name}`, "done");
    }
  }
}

// ── KRISO 단톡방: 대화 · 업무 보드 · 타워 재생 ──
async function loadChat() {
  try {
    const [c, ins] = await Promise.all([api("/api/chat?limit=60"), api("/api/insights")]);
    S.chat.messages = c.messages;
    S.chat.insights = ins.insights;
    S.chat.error = null;
  } catch (err) {
    S.chat.error = err.message;
  }
  mergeDeadlines();
  renderChat();
  renderBoard();
  renderKpis();
  renderProjects();
  renderTimeline();
  renderUpcoming();
}

function chatAvatar(m) {
  const p = S.people[m.person];
  if (p) return `<img src="${p.photo}" alt="" />`;
  return `<span class="ch-ini">${esc((m.who || "?").replace(/대표님|님/g, "").slice(0, 2))}</span>`;
}
function chatBody(m) {
  if (m.kind === "file") return `<span class="ch-file">📎 ${esc(m.text.replace(/^파일: /, ""))}</span>`;
  if (m.kind === "photo") return `<span class="ch-muted">🖼️ 사진</span>`;
  if (m.kind === "deleted") return `<span class="ch-muted">삭제된 메시지</span>`;
  if (m.kind === "link") return `<a href="${esc(m.text)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(m.text.length > 60 ? m.text.slice(0, 60) + "…" : m.text)}</a>`;
  const t = m.text.length > 400 ? m.text.slice(0, 400) + "…" : m.text;
  return esc(t);
}
function renderChat() {
  const card = $("#chatCard");
  card.hidden = false;
  const box = $("#chat");
  if (S.chat.error) {
    box.innerHTML = `<p class="empty">${esc(S.chat.error)}</p>`;
    return;
  }
  const list = S.chat.messages;
  $("#chatCount").textContent = list.length ? `최근 ${list.length}건` : "";
  if (!list.length) {
    box.innerHTML = `<p class="empty">아직 쌓인 대화가 없어요. 카카오톡에서 대화 내보내기 한 .txt 파일을 올려 주세요.</p>`;
    return;
  }
  let lastDay = "";
  box.innerHTML = `<button type="button" class="link-btn ch-more" id="chatMore">이전 대화 더 보기</button>` + list.map((m) => {
    const ms = Date.parse(m.t);
    const day = ymdK(ms);
    const sep = day !== lastDay ? `<div class="ch-day">${md(ms)}(${wd(ms)})</div>` : "";
    lastDay = day;
    if (m.kind === "system") return `${sep}<div class="ch-sys">${esc(m.text)}</div>`;
    const mine = m.person === "shin";
    return `${sep}<div class="ch-msg${mine ? " mine" : ""}">${mine ? "" : `<div class="ch-av">${chatAvatar(m)}</div>`}<div class="ch-col">${mine ? "" : `<b class="ch-who">${esc(S.people[m.person]?.name || m.who)}</b>`}<div class="ch-row"><div class="ch-bub">${chatBody(m)}</div><time>${hm(ms)}</time></div></div></div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
  $("#chatMore").onclick = async () => {
    try {
      const more = (await api(`/api/chat?limit=80&before=${encodeURIComponent(S.chat.messages[0].t)}`)).messages;
      if (!more.length) return ($("#chatMore").textContent = "처음 대화까지 다 봤어요");
      const h = box.scrollHeight;
      S.chat.messages = [...more, ...S.chat.messages];
      renderChat();
      box.scrollTop = box.scrollHeight - h;
    } catch (err) {
      $("#chatMore").textContent = err.message;
    }
  };
}
$("#chatFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const st = $("#chatStatus");
  st.hidden = false;
  st.textContent = `${file.name} 읽는 중…`;
  try {
    const text = await file.text();
    const r = await api("/api/chat/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: "kriso", text }) });
    st.textContent = `✅ ${r.parsed.toLocaleString()}건 중 새 메시지 ${r.inserted.toLocaleString()}건을 쌓았어요 (누적 ${r.total.toLocaleString()}건)`;
    S.chat.days = null;
    await loadChat();
    if (isVoiceEnabled()) announce(`단톡방 새 메시지 ${r.inserted}건을 쌓았어요.`, "done");
  } catch (err) {
    st.textContent = `⚠️ ${err.message}`;
  }
});

function renderBoard() {
  const ins = S.chat.insights;
  $("#boardCard").hidden = !ins;
  if (!ins) return;
  const t = now();
  const when = ins.analyzedAt ? `${md(Date.parse(ins.analyzedAt))} ${hm(Date.parse(ins.analyzedAt))} 정리` : "";
  $("#boardMeta").textContent = when;
  const link = $("#sheetLink");
  link.hidden = !ins.sheetUrl;
  if (ins.sheetUrl) link.href = ins.sheetUrl;
  const ST = { todo: ["할 일", "todo"], doing: ["진행 중", "doing"], done: ["완료", "done"] };
  const order = ["shin", "yang", "leejh", "leebu"];
  const byWho = order.map((id) => ({ id, tasks: ins.tasks.filter((x) => x.who === id) })).filter((g) => g.tasks.length);
  const deadlines = (ins.deadlines || []).map((d) => {
    const ms = d.date ? Date.parse(d.date + "T00:00:00+09:00") : null;
    return `<li><span class="chip-s" style="--c:#0E7490">${ms ? dDay(ms, t) : "미정"}</span> <b>${esc(d.title)}</b> <small class="muted">${d.date ? md(ms) + "(" + wd(ms) + ")" : ""} ${esc(d.note || "")}</small></li>`;
  }).join("");
  $("#board").innerHTML = `
    <div class="bd-summary"><span class="p-status" data-status="soon" style="--c:#0E7490">${esc(ins.stage || "")}</span><p>${esc(ins.summary || "")}</p></div>
    <div class="bd-grid">
      ${byWho.map((g) => {
        const p = S.people[g.id];
        return `<section class="bd-col" style="--c:${p.color}"><h4><img src="${p.photo}" alt="" />${esc(p.name)} <small>${g.tasks.filter((x) => x.status !== "done").length}건 남음</small></h4>
          <ul>${g.tasks.map((x) => `<li class="bd-task" data-status="${x.status}"><span class="bd-st">${ST[x.status]?.[0] || x.status}</span><div><b>${esc(x.title)}</b>${x.detail ? `<small>${esc(x.detail)}</small>` : ""}<small class="bd-src">근거 ${esc(String(x.from || "").slice(5, 16).replace("T", " "))} 대화</small></div></li>`).join("")}</ul></section>`;
      }).join("")}
    </div>
    <div class="bd-lower">
      <section><h4>마감</h4><ul class="bd-list">${deadlines}</ul></section>
      <section><h4>결정 사항</h4><ul class="bd-list">${(ins.decisions || []).map((d) => `<li><small class="muted">${md(Date.parse(d.date + "T00:00:00+09:00"))}</small> ${esc(d.text)}</li>`).join("")}</ul></section>
    </div>
    ${ins.open?.length ? `<p class="small bd-open">확인 필요: ${ins.open.map(esc).join(" · ")}</p>` : ""}`;
}

// 타워: 하루치 단톡방 대화를 5층 회의 테이블에서 말풍선으로 재생
async function setupReplay() {
  try {
    if (!S.chat.days) S.chat.days = await api("/api/chat/days");
  } catch {
    return;
  }
  const days = S.chat.days.days.filter((d) => d.n >= 3);
  if (!days.length) return;
  $("#replayRow").hidden = false;
  $("#replayDay").innerHTML = days.map((d) => `<option value="${d.day}">${d.day.slice(5).replace("-", "/")} · ${d.n}건</option>`).join("");
  const busy = days.find((d) => d.n >= 12);
  if (busy) $("#replayDay").value = busy.day;
}
$("#replayBtn").addEventListener("click", () => (S.replay ? stopReplay() : startReplay($("#replayDay").value)));

async function startReplay(day) {
  if (!office || !day) return;
  unlock();
  let msgs;
  try {
    msgs = (await api(`/api/chat?day=${day}`)).messages.filter((m) => m.kind !== "system");
  } catch (err) {
    $("#officeWhat").textContent = err.message;
    return;
  }
  if (!msgs.length) return;
  const kriso = S.byId.kriso;
  S.replay = { timer: null };
  $("#replayBtn").textContent = "■ 재생 멈춤";
  $("#officeNow").hidden = true;
  office.focusFloor(kriso.floor);
  const members = kriso.members.map((m) => m.id);
  members.forEach((id, k) => {
    office.hideBubble(id);
    office.setState(id, "moving");
    office.moveTo(id, { floor: kriso.floor, kind: "meeting", slot: k }).then(() => office.setState(id, "present"));
  });
  const d = Date.parse(day + "T00:00:00+09:00");
  $("#officeWhen").textContent = `${md(d)}(${wd(d)}) 단톡방`;
  if (isVoiceEnabled()) announce(`${md(d).replace("/", "월 ")}일 단톡방 대화 ${msgs.length}건을 재생할게요.`, "step");
  let i = 0;
  let last = null;
  const step = () => {
    if (!S.replay) return;
    if (i >= msgs.length) return stopReplay(true);
    const m = msgs[i++];
    const who = m.person && members.includes(m.person) ? m.person : null;
    if (last && last !== who) {
      office.hideBubble(last);
      office.setState(last, "present");
    }
    const text = m.kind === "text" ? m.text.replace(/\s+/g, " ") : m.kind === "file" ? "📎 " + m.text.replace(/^파일: /, "") : m.kind === "photo" ? "🖼️ 사진" : m.kind === "link" ? "🔗 링크 공유" : "(삭제된 메시지)";
    const short = text.length > 90 ? text.slice(0, 90) + "…" : text;
    if (who) {
      office.showBubble(who, "say", short);
      office.setState(who, "meeting");
    }
    last = who;
    $("#officeWhat").textContent = `${hm(Date.parse(m.t))} ${S.people[m.person]?.name || m.who}: ${short}`;
    const dur = Math.min(4200, Math.max(1500, 900 + short.length * 38));
    S.replay.timer = setTimeout(step, dur);
  };
  S.replay.timer = setTimeout(step, 2600);
}
function stopReplay(finished = false) {
  if (!S.replay) return;
  clearTimeout(S.replay.timer);
  S.replay = null;
  $("#replayBtn").textContent = "▶ 단톡방 대화 재생";
  for (const id of Object.keys(S.people)) office?.hideBubble(id);
  if (finished && isVoiceEnabled()) announce("단톡방 대화 재생을 마쳤어요.", "done");
  syncOffice(false);
}

// ── 화면 전환 ──
function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const view = ["monitor", "office", "reports"].includes(name) ? name : "monitor";
  for (const el of $$(".view")) el.hidden = el.dataset.view !== view;
  for (const a of $$(".nav a")) a.classList.toggle("active", a.dataset.view === view);
  if (view === "office") ensureOffice().then(() => office?.setActive(true));
  else office?.setActive(false);
  if (view === "reports") loadReports();
}
addEventListener("hashchange", () => S.data && route());

// 30초마다 시계·상태, 5분마다 캘린더 새로 읽기
setInterval(() => {
  if (!S.data) return;
  renderClock();
  checkReminders();
}, 15_000);
setInterval(() => {
  if (!S.data) return;
  renderHero();
  renderKpis();
  renderPeople();
  if (!S.virtual) syncOffice(false);
}, 60_000);
setInterval(async () => {
  if (!S.data || document.hidden) return;
  try {
    await load();
    renderAll();
    loadChat();
  } catch {}
}, 5 * 60_000);

setupSound();
(async () => {
  let cfg = { needsPasscode: true };
  try { cfg = await (await fetch("/api/config")).json(); } catch {}
  if (cfg.needsPasscode && !S.code) return showLock();
  start();
})();
