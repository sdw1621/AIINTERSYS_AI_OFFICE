// 구글 캘린더 일정 → 프로젝트 일정.
// 1순위: GCAL_ICS_URL (구글 캘린더 '비공개 주소(iCal 형식)'). 접속할 때마다 최신 일정을 읽는다 (5분 캐시).
// 2순위: DB에 동기화해 둔 일정 (office_events 테이블).
// 프로젝트에 해당하는 일정만 남기고, 나머지 개인 일정은 서버 밖으로 내보내지 않는다.

import ical from "node-ical";
import { matchProject, projectById } from "./projects.js";
import { dbEnabled, listEvents } from "./db.js";

const ICS_URL = process.env.GCAL_ICS_URL || "";
const CACHE_MS = 5 * 60 * 1000;
const DAY = 86_400_000;
let cache = null;

export const calendarConfigured = () => (ICS_URL ? "ical" : dbEnabled ? "db" : "none");

const text = (v) => (v && typeof v === "object" ? v.val ?? "" : v ?? "");
const stripHtml = (s) => String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 일정에 들어가는 사람: 신동욱(이 캘린더 주인)은 항상, KRISO 일정은 프로젝트 구성원 전원
function peopleFor(projectId) {
  const p = projectById[projectId];
  return projectId === "kriso" ? p.members.map((m) => m.id) : ["shin"];
}

export function normalize(raw) {
  const project = matchProject(raw);
  if (!project) return null;
  return { ...raw, description: (raw.description || "").slice(0, 400), project, people: peopleFor(project) };
}

async function fetchIcs() {
  const res = await fetch(ICS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`구글 캘린더를 읽지 못했어요 (HTTP ${res.status}). iCal 주소를 확인해 주세요.`);
  const data = ical.sync.parseICS(await res.text());
  const from = new Date(Date.now() - 150 * DAY);
  const to = new Date(Date.now() + 240 * DAY);
  const out = [];

  const push = (ev, start, end, idSuffix = "") => {
    const allDay = Boolean(ev.start?.dateOnly || ev.datetype === "date");
    const raw = {
      id: `${ev.uid}${idSuffix}`,
      title: text(ev.summary),
      description: stripHtml(text(ev.description)),
      location: text(ev.location),
      allDay,
      start: allDay ? ymd(start) : start.toISOString(),
      end: allDay ? ymd(end) : end.toISOString(),
    };
    const n = normalize(raw);
    if (n) out.push(n);
  };

  for (const ev of Object.values(data)) {
    if (ev.type !== "VEVENT" || ev.status === "CANCELLED" || !ev.start) continue;
    const dur = (ev.end ? +ev.end : +ev.start + (ev.start.dateOnly ? DAY : 3_600_000)) - +ev.start;
    if (!ev.rrule) {
      if (+ev.start < +to && +ev.start + dur > +from) push(ev, ev.start, new Date(+ev.start + dur));
      continue;
    }
    // 반복 일정 펼치기 (제외일·개별 수정본 반영)
    const excluded = new Set(Object.values(ev.exdate || {}).map((d) => +d));
    const overrides = new Map(Object.values(ev.recurrences || {}).map((r) => [+(r.recurrenceid || r.start), r]));
    for (const d of ev.rrule.between(from, to, true)) {
      // rrule은 '그 시간대의 벽시계 시각'을 UTC 숫자로 돌려준다 → 실제 시각으로 바꾼다
      const start = ev.start.dateOnly ? d : wallToUtc(d, ev.start.tz);
      if (excluded.has(+start)) continue;
      const over = overrides.get(+start);
      if (over) {
        if (over.status === "CANCELLED") continue;
        const oDur = (over.end ? +over.end : +over.start) - +over.start || dur;
        push({ ...ev, ...over, uid: ev.uid }, over.start, new Date(+over.start + oDur), `_${+start}`);
      } else {
        push(ev, start, new Date(+start + dur), `_${+start}`);
      }
    }
  }
  return out;
}

// 시간대 tz에서 벽시계 시각(UTC 필드에 담긴)을 실제 UTC 시각으로
function tzOffset(tz, date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const g = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute, +g.second) - (date.getTime() - date.getMilliseconds());
}
function wallToUtc(d, tz) {
  if (!tz || /^(etc\/)?utc$|^z$/i.test(tz)) return d;
  try {
    let t = +d - tzOffset(tz, d);
    t = +d - tzOffset(tz, new Date(t)); // 서머타임 경계 보정
    return new Date(t);
  } catch {
    return d; // 모르는 시간대 이름이면 그대로
  }
}

export async function getEvents() {
  if (ICS_URL) {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      try {
        cache = { at: Date.now(), events: await fetchIcs(), error: null };
      } catch (err) {
        // 읽기에 실패하면 직전 결과를 계속 쓰고, 처음부터 실패면 DB 동기화본으로 대신한다
        if (cache) cache.error = err.message;
        else {
          const db = dbEnabled ? await listEvents() : { events: [], syncedAt: null };
          return { source: "db", syncedAt: db.syncedAt, events: db.events, error: err.message };
        }
      }
    }
    return { source: "ical", syncedAt: new Date(cache.at).toISOString(), events: cache.events, error: cache.error };
  }
  if (dbEnabled) {
    const db = await listEvents();
    return { source: "db", syncedAt: db.syncedAt, events: db.events };
  }
  return { source: "none", syncedAt: null, events: [] };
}
