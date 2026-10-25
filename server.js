import express from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PEOPLE, PROJECTS, publicProjects } from "./src/projects.js";
import { getEvents, calendarConfigured } from "./src/calendar.js";
import { dbEnabled, listReports, getReport, deleteReport, importChat, listChat, chatDays, allChat, getInsights, listBot, addBot, upsertKG, getKG, kgScopeCount, botProject, listFiles, driveFolders, addFiles, setFileDrive, saveFileVersions } from "./src/db.js";
import { seedProject, extractFromText } from "./src/kg.js";
import { quickAnswer } from "./src/bot.js";
import { versionize, CATEGORIES, driveTitle } from "./src/files.js";
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
    // 파일 메시지는 자료 이력에도 쌓는다 (드라이브 저장은 지피가 받은 파일함에서 정리)
    const files = messages.filter((m) => m.kind === "file").map((m) => ({ t: m.t, who: m.who, person: m.person, name: m.text.replace(/^파일:\s*/, "").split("\n")[0] }));
    const newFiles = await addFiles(room, files);
    res.json({ title, parsed: messages.length, newFiles, ...r });
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

// ── 지피 대화창(층별): 메시지 → DB 적재 + 그 층 지식 그래프 누적 → 빠른 답(그 층 지식) + 지피 답(나중에) ──
const SCOPES = new Set(["all", ...PROJECTS.map((p) => p.id)]);
const scopeOf = (v) => (SCOPES.has(String(v)) ? String(v) : "all");
async function ensureSeed(scope) {
  const list = scope === "all" ? PROJECTS : PROJECTS.filter((p) => p.id === scope);
  for (const pr of list) {
    if ((await kgScopeCount(pr.id)) > 0) continue;
    const g = seedProject(pr, pr.id === "kriso" ? await getInsights("kriso") : null);
    await upsertKG(g.nodes, g.edges, null, pr.id);
  }
}
app.get("/api/bot", requireCode, requireDb, async (req, res) => {
  try {
    const after = Math.max(0, Number(req.query.after) || 0);
    res.json({ messages: await listBot({ after, project: scopeOf(req.query.project) }), llm: llmEnabled });
  } catch (err) {
    dbError(res, err);
  }
});
app.post("/api/bot", requireCode, requireDb, async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 1000);
  const project = scopeOf(req.body?.project);
  if (!text) return res.status(400).json({ error: "메시지가 비어 있어요." });
  try {
    await ensureSeed(project);
    const mine = await addBot({ role: "user", who: "shin", text, status: "pending", project });
    const known = (await getKG(project)).nodes;
    const g = extractFromText(text, known);
    g.nodes.push({ id: "person:shin", label: "신동욱", type: "Person", mention: false });
    for (const n of g.nodes) if (n.id !== "person:shin") g.edges.push({ src: "person:shin", rel: "ASKED_ABOUT", dst: n.id });
    if (project !== "all") for (const n of g.nodes) if (n.type !== "Person" && n.type !== "Project") g.edges.push({ src: n.id, rel: "PART_OF", dst: `project:${project}` });
    await upsertKG(g.nodes, g.edges, mine.id, project);
    // 빠른 답: 그 층의 지식에서만 찾는다 (LLM이 연결돼 있으면 KRISO는 LLM 답)
    const [chat, insights, history] = project === "kriso" || project === "all"
      ? await Promise.all([listChat("kriso", { limit: 200 }), getInsights("kriso"), listBot({ project, limit: 200 })])
      : [[], null, await listBot({ project, limit: 200 })];
    const a = await quickAnswer(text, project, { chat, insights, history: history.filter((m) => m.id !== mine.id) });
    const kind = a.source === "llm" ? "answer" : "quick";
    await addBot({ role: "bot", who: a.source === "llm" ? "jipi" : a.who, text: a.text, kind, replyTo: mine.id, project });
    res.json({ ok: true, id: mine.id, linked: g.nodes.filter((n) => n.mention).map((n) => n.label) });
  } catch (err) {
    dbError(res, err);
  }
});
// 지피(또는 로컬 LLM 작업자)가 답과 새 지식을 올리는 곳 — 층은 원래 메시지를 따른다
app.post("/api/bot/answer", requireCodeOrImportKey, requireDb, async (req, res) => {
  const replyTo = Number(req.body?.reply_to) || null;
  const text = String(req.body?.text || "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: "답이 비어 있어요." });
  try {
    const project = replyTo ? await botProject(replyTo) : scopeOf(req.body?.project);
    const r = await addBot({ role: "bot", who: "jipi", text, kind: "answer", replyTo, project });
    const kg = req.body?.kg || {};
    await upsertKG(Array.isArray(kg.nodes) ? kg.nodes : [], Array.isArray(kg.edges) ? kg.edges : [], replyTo, project);
    res.json({ ok: true, id: r.id });
  } catch (err) {
    dbError(res, err);
  }
});
app.get("/api/kg", requireCode, requireDb, async (req, res) => {
  const scope = scopeOf(req.query.scope);
  try {
    await ensureSeed(scope);
    res.json({ scope, ...(await getKG(scope)) });
  } catch (err) {
    dbError(res, err);
  }
});

// ── 자료 이력: 단톡방 파일을 문서군·버전으로 묶어 보여 주고, 드라이브 자료실 링크를 붙인다 ──
async function fileHistory(room) {
  const [rows, folders] = await Promise.all([listFiles(room), driveFolders()]);
  const v = versionize(rows);
  const changed = v.filter((r) => r.db_family !== (r.family ?? null) || r.db_version !== r.version || r.db_latest !== Boolean(r.latest) || r.db_category !== r.category);
  if (changed.length) await saveFileVersions(changed.map((r) => ({ id: r.id, family: r.family, version: r.version, latest: Boolean(r.latest), category: r.category, junk: Boolean(r.junk), reshare: Boolean(r.reshare) })));
  const fams = new Map();
  for (const r of v) {
    if (r.junk) continue;
    const f = fams.get(r.family) || { family: r.family, category: r.category, name: r.name, versions: [] };
    f.versions.push({ id: r.id, v: r.version, t: r.t, who: NAMES[r.person] || (r.who || "").replace(/대표님|님/g, ""), person: r.person, name: r.name, reshare: r.reshare, status: r.status, url: r.drive_url, title: driveTitle(r, NAMES) });
    f.name = r.name; // 최신 이름
    f.last = r.t;
    fams.set(r.family, f);
  }
  const fol = Object.fromEntries(folders.filter((x) => x.room === room || x.room === "*").map((x) => [x.category, `https://drive.google.com/drive/folders/${x.folder_id}`]));
  const families = [...fams.values()].sort((a, b) => b.last.localeCompare(a.last));
  const saved = v.filter((r) => r.status === "saved").length;
  return { room, total: v.filter((r) => !r.junk).length, saved, families, categories: CATEGORIES.map((c) => ({ id: c.id, name: c.name, url: fol[c.id] || null })), folders: { root: fol.root || null, inbox: fol.inbox || null, floor: fol.floor || null } };
}
app.get("/api/files", requireCode, requireDb, async (req, res) => {
  try {
    res.json(await fileHistory(roomOf(req) || "kriso"));
  } catch (err) {
    dbError(res, err);
  }
});
// 지피(정리 작업)가 드라이브에 저장한 뒤 링크를 붙이는 곳
app.post("/api/files/:id/drive", requireCodeOrImportKey, requireDb, async (req, res) => {
  const { drive_id, drive_url, drive_title, note } = req.body || {};
  if (!drive_id || !drive_url) return res.status(400).json({ error: "drive_id·drive_url이 필요해요." });
  try {
    await setFileDrive(Number(req.params.id), { drive_id, drive_url, drive_title, note });
    res.json({ ok: true });
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
      case "files": {
        const h = await fileHistory(room);
        const cat = Object.fromEntries(h.categories.map((c) => [c.id, c.name.replace(/^\d+\s*/, "")]));
        rows = [["분류", "문서", "버전", "최신", "날짜", "올린 사람", "파일 이름", "드라이브", "링크"]];
        for (const f of h.families) for (const x of [...f.versions].reverse()) rows.push([cat[f.category] || f.category, f.name, `v${x.v}${x.reshare ? " (재공유)" : ""}`, x.v === Math.max(...f.versions.map((y) => y.v)) ? "★" : "", stampK(new Date(Date.parse(x.t) + 9 * 3600e3).toISOString().slice(0, 16)), x.who, x.name, x.status === "saved" ? "저장됨" : "파일 필요", x.url || ""]);
        break;
      }
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
