import express from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PEOPLE, publicProjects } from "./src/projects.js";
import { getEvents, calendarConfigured } from "./src/calendar.js";
import { dbEnabled, listReports, getReport, deleteReport, importChat, listChat, chatDays, allChat, getInsights } from "./src/db.js";
import { parseKakao } from "./src/chat.js";
import { meetingScript, answer, llmEnabled } from "./src/meeting.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ON_VERCEL = Boolean(process.env.VERCEL);
// 실제 사람·프로젝트·일정이 담기므로, 공개 배포에서는 접속 코드 없이는 아무것도 보여 주지 않는다.
const PASSCODE = process.env.OFFICE_PASSCODE || "";
const LOCKED_OUT = ON_VERCEL && !PASSCODE; // 코드 없이 공개 배포된 경우: 데이터 API를 아예 닫는다

const app = express();
// 단톡방 대화 파일(수백 KB)을 받으므로 여유를 둔다. (Vercel 요청 본문 상한 약 4.5MB)
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(here, "public")));

function passcodeOk(given) {
  if (!PASSCODE) return !ON_VERCEL;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(PASSCODE);
  return a.length === b.length && timingSafeEqual(a, b);
}
// 단톡방 자동 수집(PC 스크립트·예약 작업)은 접속 코드 대신 IMPORT_KEY로도 올릴 수 있다
const IMPORT_KEY = process.env.IMPORT_KEY || "";
function requireCodeOrImportKey(req, res, next) {
  const k = Buffer.from(String(req.get("x-import-key") || ""));
  const want = Buffer.from(IMPORT_KEY);
  if (IMPORT_KEY && k.length === want.length && timingSafeEqual(k, want)) {
    res.set("Cache-Control", "no-store");
    return next();
  }
  return requireCode(req, res, next);
}
function requireCode(req, res, next) {
  if (LOCKED_OUT) return res.status(503).json({ error: "서버에 OFFICE_PASSCODE가 설정되어 있지 않아 열 수 없어요." });
  if (!passcodeOk(req.get("x-office-passcode"))) return res.status(401).json({ error: "접속 코드가 맞지 않아요.", code: "bad_passcode" });
  res.set("Cache-Control", "no-store");
  next();
}

// 공개 정보: 잠금 여부만
app.get("/api/config", (_req, res) => {
  res.json({ needsPasscode: Boolean(PASSCODE) || ON_VERCEL, calendar: calendarConfigured(), reports: dbEnabled, llm: llmEnabled });
});

// 사무실 전체: 프로젝트 · 사람 · 일정
app.get("/api/office", requireCode, async (_req, res) => {
  try {
    const cal = await getEvents();
    res.json({ projects: publicProjects(), people: PEOPLE, calendar: cal, now: new Date().toISOString() });
  } catch (err) {
    console.error("[office]", err);
    res.status(500).json({ error: "일정을 불러오지 못했어요." });
  }
});

// ── 보고함 (Neon DB) ──
function requireDb(req, res, next) {
  if (!dbEnabled) return res.status(404).json({ error: "보고함(DB)이 설정되어 있지 않아요." });
  next();
}
const dbError = (res, err) => {
  console.error("[db]", err);
  res.status(500).json({ error: "DB 처리 중 오류가 났어요." });
};
app.get("/api/reports", requireCode, requireDb, async (_req, res) => {
  try {
    res.json({ reports: await listReports() });
  } catch (err) {
    dbError(res, err);
  }
});
app.get("/api/reports/:id", requireCode, requireDb, async (req, res) => {
  try {
    const r = await getReport(req.params.id);
    if (!r) return res.status(404).json({ error: "보고서를 찾을 수 없어요." });
    res.json(r);
  } catch (err) {
    dbError(res, err);
  }
});
app.delete("/api/reports/:id", requireCode, requireDb, async (req, res) => {
  try {
    await deleteReport(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    dbError(res, err);
  }
});

// ── 단톡방 (카카오톡 대화 누적) ──
const ROOMS = new Set(["kriso"]);
const roomOf = (req) => (ROOMS.has(String(req.query.room || req.body?.room || "kriso")) ? String(req.query.room || req.body?.room || "kriso") : null);
app.get("/api/chat", requireCode, requireDb, async (req, res) => {
  const room = roomOf(req);
  if (!room) return res.status(400).json({ error: "알 수 없는 대화방이에요." });
  try {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || "") ? req.query.day : null;
    const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 60));
    res.json({ room, messages: await listChat(room, { limit, before, day }) });
  } catch (err) {
    dbError(res, err);
  }
});
app.get("/api/chat/days", requireCode, requireDb, async (req, res) => {
  try {
    res.json(await chatDays(roomOf(req) || "kriso"));
  } catch (err) {
    dbError(res, err);
  }
});
// 카카오톡 '대화 내보내기' 파일 내용을 그대로 받아 새 메시지만 쌓는다
app.post("/api/chat/import", requireCodeOrImportKey, requireDb, async (req, res) => {
  const room = roomOf(req);
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!room || !text) return res.status(400).json({ error: "대화 파일 내용이 비어 있어요." });
  const { title, messages } = parseKakao(text);
  if (!messages.length) return res.status(400).json({ error: "카카오톡 대화 내보내기 형식이 아니에요." });
  try {
    const r = await importChat(room, messages);
    res.json({ title, parsed: messages.length, ...r });
  } catch (err) {
    dbError(res, err);
  }
});
app.get("/api/insights", requireCode, requireDb, async (req, res) => {
  try {
    res.json({ insights: await getInsights(roomOf(req) || "kriso") });
  } catch (err) {
    dbError(res, err);
  }
});

// ── AI 음성 회의: 하루치 대화 → 회의 대본, 회의 중 끼어들기 질문 → 담당자 답변 ──
const dayOf = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null);
app.get("/api/meeting", requireCode, requireDb, async (req, res) => {
  const day = dayOf(req.query.day);
  if (!day) return res.status(400).json({ error: "날짜(day=YYYY-MM-DD)가 필요해요." });
  try {
    const [messages, insights] = await Promise.all([listChat("kriso", { day }), getInsights("kriso")]);
    if (!messages.length) return res.status(404).json({ error: "그날 대화가 없어요." });
    res.json({ day, count: messages.length, ...(await meetingScript(day, messages, insights)) });
  } catch (err) {
    dbError(res, err);
  }
});
app.post("/api/meeting/ask", requireCode, requireDb, async (req, res) => {
  const q = String(req.body?.question || "").trim().slice(0, 300);
  if (!q) return res.status(400).json({ error: "질문이 비어 있어요." });
  try {
    const day = dayOf(req.body?.day);
    const [recent, dayMsgs, insights] = await Promise.all([listChat("kriso", { limit: 200 }), day ? listChat("kriso", { day }) : [], getInsights("kriso")]);
    const seen = new Set();
    const messages = [...recent, ...dayMsgs].filter((m) => !seen.has(m.t + m.text) && seen.add(m.t + m.text)).sort((a, b) => a.t.localeCompare(b.t));
    res.json(await answer(q, messages, insights));
  } catch (err) {
    dbError(res, err);
  }
});

// ── 구글 시트 연동: =IMPORTDATA("…/api/sheet/<탭>.csv?key=…") 로 시트가 직접 읽어 간다 ──
const SHEET_KEY = process.env.SHEET_EXPORT_KEY || "";
const csv = (rows) => rows.map((r) => r.map((v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(",")).join("\r\n");
const NAMES = { shin: "신동욱", yang: "양선희", leebu: "이부일", leejh: "이재현" };
const STATUS = { todo: "할 일", doing: "진행 중", done: "완료" };
const KIND = { text: "대화", file: "파일", photo: "사진", link: "링크", deleted: "삭제", system: "시스템" };
// 구글 시트가 날짜·시각을 숫자(일련번호)로 바꾸지 않도록 요일과 「시·분」을 붙인 글자로 내보낸다
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const dayK = (d) => (/^\d{4}-\d{2}-\d{2}/.test(d || "") ? `${d.slice(0, 10)}(${WD[new Date(d.slice(0, 10) + "T00:00:00Z").getUTCDay()]})` : d || "");
const timeK = (hm) => (/^\d{2}:\d{2}/.test(hm || "") ? `${hm.slice(0, 2)}시 ${hm.slice(3, 5)}분` : hm || "");
const stampK = (v) => { const s = String(v || "").replace("T", " "); return s.length >= 16 ? `${dayK(s)} ${timeK(s.slice(11, 16))}` : dayK(s); };
app.get("/api/sheet/:tab.csv", async (req, res) => {
  const given = Buffer.from(String(req.query.key || ""));
  const want = Buffer.from(SHEET_KEY);
  if (!SHEET_KEY || !dbEnabled || given.length !== want.length || !timingSafeEqual(given, want)) return res.status(404).send("not found");
  try {
    const room = "kriso";
    let rows;
    const ins = (await getInsights(room)) || {};
    switch (req.params.tab) {
      case "chat":
        rows = [["날짜", "시각", "보낸 사람", "프로젝트 인원", "유형", "내용"], ...(await allChat(room)).map((m) => {
          return [dayK(m.kst), timeK(m.kst.slice(11, 16)), m.who || "(시스템)", NAMES[m.person] || "", KIND[m.kind] || m.kind, m.text.slice(0, 5000)];
        })];
        break;
      case "tasks":
        rows = [["담당", "상태", "업무", "내용", "근거(대화 시각)"], ...(ins.tasks || []).map((t) => [NAMES[t.who] || t.who, STATUS[t.status] || t.status, t.title, t.detail || "", stampK(t.from)])];
        break;
      case "deadlines":
        rows = [["날짜", "항목", "메모", "근거(대화 시각)"], ...(ins.deadlines || []).map((d) => [d.date ? dayK(d.date) : "확인 필요", d.title, d.note || "", stampK(d.from)])];
        break;
      case "decisions":
        rows = [["날짜", "결정"], ...(ins.decisions || []).map((d) => [dayK(d.date), d.text])];
        break;
      case "milestones":
        rows = [["날짜", "내용"], ...(ins.milestones || []).map((d) => [dayK(d.date), d.text])];
        break;
      case "overview": {
        const { total, days } = await chatDays(room);
        rows = [["항목", "내용"], ["단톡방", ins.title || ""], ["현재 단계", ins.stage || ""], ["요약", ins.summary || ""], ["누적 메시지", total], ["대화 기간", days.length ? `${dayK(String(days.at(-1).day))} ~ ${dayK(String(days[0].day))}` : ""], ["분석 시각", stampK(String(ins.analyzedAt || "").slice(0, 16))], ["확인 필요", (ins.open || []).join(" / ")]];
        break;
      }
      default:
        return res.status(404).send("not found");
    }
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" }).send(csv(rows));
  } catch (err) {
    console.error("[sheet]", err);
    res.status(500).send("error");
  }
});

export default app;

if (!ON_VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`\n🏢 AIINTERSYS AI TOWER: http://localhost:${PORT}`);
    console.log(`   일정: ${{ ical: "구글 캘린더(iCal)", db: "DB 동기화본", none: "없음" }[calendarConfigured()]}`);
    console.log(PASSCODE ? "   접속 코드 사용" : "   접속 코드 없음 (로컬 전용)");
  });
}
