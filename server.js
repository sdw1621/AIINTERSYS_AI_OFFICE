import express from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PEOPLE, publicProjects } from "./src/projects.js";
import { getEvents, calendarConfigured } from "./src/calendar.js";
import { dbEnabled, listReports, getReport, deleteReport } from "./src/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ON_VERCEL = Boolean(process.env.VERCEL);
// 실제 사람·프로젝트·일정이 담기므로, 공개 배포에서는 접속 코드 없이는 아무것도 보여 주지 않는다.
const PASSCODE = process.env.OFFICE_PASSCODE || "";
const LOCKED_OUT = ON_VERCEL && !PASSCODE; // 코드 없이 공개 배포된 경우: 데이터 API를 아예 닫는다

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

function passcodeOk(given) {
  if (!PASSCODE) return !ON_VERCEL;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(PASSCODE);
  return a.length === b.length && timingSafeEqual(a, b);
}
function requireCode(req, res, next) {
  if (LOCKED_OUT) return res.status(503).json({ error: "서버에 OFFICE_PASSCODE가 설정되어 있지 않아 열 수 없어요." });
  if (!passcodeOk(req.get("x-office-passcode"))) return res.status(401).json({ error: "접속 코드가 맞지 않아요.", code: "bad_passcode" });
  res.set("Cache-Control", "no-store");
  next();
}

// 공개 정보: 잠금 여부만
app.get("/api/config", (_req, res) => {
  res.json({ needsPasscode: Boolean(PASSCODE) || ON_VERCEL, calendar: calendarConfigured(), reports: dbEnabled });
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

export default app;

if (!ON_VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`\n🏢 AIINTERSYS AI TOWER: http://localhost:${PORT}`);
    console.log(`   일정: ${{ ical: "구글 캘린더(iCal)", db: "DB 동기화본", none: "없음" }[calendarConfigured()]}`);
    console.log(PASSCODE ? "   접속 코드 사용" : "   접속 코드 없음 (로컬 전용)");
  });
}
