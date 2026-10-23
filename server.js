import express from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { AGENTS, TEAMS, FLOORS } from "./src/agents.js";
import { Job } from "./src/jobs.js";
import { runLiveJob, describeLiveConfig } from "./src/orchestrator.js";
import { runDemoJob } from "./src/demo.js";
import { normalizeMaterials } from "./src/materials.js";
import { dbEnabled, reportFromJob, saveReport, listReports, getReport, deleteReport } from "./src/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// API 요금이 드는 서버이므로 로컬 실행은 기본적으로 이 PC에서만 접속 가능하게 연다.
const HOST = process.env.HOST || "127.0.0.1";
const ON_VERCEL = Boolean(process.env.VERCEL);
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// 인터넷에 공개된 배포에서는 아무나 API 요금을 쓰지 못하도록 실제 모드에 접속 코드를 요구한다.
const PASSCODE = process.env.OFFICE_PASSCODE || "";
const LIVE_AVAILABLE = HAS_KEY && (!ON_VERCEL || Boolean(PASSCODE));
// 공용 보고함(DB)도 공개 배포에서는 접속 코드가 있어야 읽고 쓸 수 있다 (자료 분석 결과가 담기므로)
const DB_AVAILABLE = dbEnabled && (!ON_VERCEL || Boolean(PASSCODE));

const app = express();
// 첨부 자료(텍스트·축소 이미지)가 함께 오므로 여유를 둔다. (Vercel 함수 요청 본문 상한은 약 4.5MB)
app.use(express.json({ limit: "8mb" }));
// Vercel에서는 public/ 폴더를 CDN이 직접 서빙하고, 로컬에서는 Express가 서빙한다.
app.use(express.static(path.join(here, "public")));

app.get("/api/config", (_req, res) => {
  res.json({
    agents: AGENTS,
    teams: TEAMS,
    floors: FLOORS,
    liveAvailable: LIVE_AVAILABLE,
    needsPasscode: Boolean(PASSCODE) && (LIVE_AVAILABLE || DB_AVAILABLE),
    dbAvailable: DB_AVAILABLE,
    live: LIVE_AVAILABLE ? describeLiveConfig() : null,
    liveUnavailableReason: !HAS_KEY
      ? "서버에 ANTHROPIC_API_KEY가 설정되어 있지 않아요"
      : !LIVE_AVAILABLE
        ? "공개 배포에서는 OFFICE_PASSCODE를 설정해야 실제 모드를 쓸 수 있어요"
        : null,
  });
});

function passcodeOk(given) {
  if (!PASSCODE) return true;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(PASSCODE);
  return a.length === b.length && timingSafeEqual(a, b);
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않습니다. ANTHROPIC_API_KEY를 확인해 주세요.";
  if (err instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 해당 모델/기능을 쓸 권한이 없습니다.";
  if (err instanceof Anthropic.RateLimitError) return "요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.";
  if (err instanceof Anthropic.BadRequestError) return `잘못된 요청입니다: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Claude API에 연결하지 못했습니다. 네트워크를 확인해 주세요.";
  if (err instanceof Anthropic.APIError) return `API 오류 (${err.status}): ${err.message}`;
  return err?.message || String(err);
}

// 업무 하나를 이 요청 안에서 끝까지 실행하면서 이벤트를 줄 단위 JSON(NDJSON)으로 흘려보낸다.
// 작업과 스트림이 같은 요청에 묶여 있어서 서버리스(Vercel)에서도 중간에 끊기지 않는다.
// 브라우저가 연결을 끊으면(중단 버튼) 작업도 함께 멈춘다.
app.post("/api/run", async (req, res) => {
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  if (!task) return res.status(400).json({ error: "업무 내용을 입력해 주세요." });
  if (task.length > 4000) return res.status(400).json({ error: "업무 내용은 4000자 이하로 입력해 주세요." });

  const wantsLive = req.body?.mode === "live";
  if (wantsLive && !LIVE_AVAILABLE) return res.status(403).json({ error: "실제 AI 모드를 사용할 수 없는 서버입니다." });
  if (wantsLive && !passcodeOk(req.get("x-office-passcode"))) {
    return res.status(401).json({ error: "접속 코드가 맞지 않습니다.", code: "bad_passcode" });
  }
  const { materials, error: matError } = normalizeMaterials(req.body?.materials);
  if (matError) return res.status(400).json({ error: matError });
  const mode = wantsLive ? "live" : "demo";
  const job = new Job(task, mode);
  job.materials = materials;
  // 공용 보고함 저장은 접속 코드를 아는 사람이 지시한 작업만
  const canSave = DB_AVAILABLE && passcodeOk(req.get("x-office-passcode"));

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const write = (line) => {
    if (!res.writableEnded) res.write(line);
  };
  job.subscribe((event) => write(JSON.stringify(event) + "\n"));
  // 프록시가 유휴 연결을 끊지 않도록 주기적으로 빈 줄을 보낸다
  const ping = setInterval(() => write("\n"), 15000);
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
    if (!job.finished) job.cancel?.();
  });

  const run = mode === "live" ? runLiveJob : runDemoJob;
  try {
    await run(job);
  } catch (err) {
    // 사용자가 중단했거나 창을 닫은 경우는 오류로 기록하지 않는다
    if (!clientGone && !job.finished) {
      console.error(`[job ${job.id}]`, err);
      job.emit("job_error", { message: friendlyError(err) });
    }
  }
  if (canSave && !clientGone && job.events.some((e) => e.type === "job_done")) {
    try {
      const report = reportFromJob(job);
      await saveReport(report);
      write(JSON.stringify({ seq: job.events.length, type: "saved", id: report.id, where: "db" }) + "\n");
    } catch (err) {
      console.error("[db save]", err);
      write(JSON.stringify({ seq: job.events.length, type: "notice", message: "공용 보고함(DB) 저장에 실패해 이 브라우저에만 저장합니다." }) + "\n");
    }
  }
  clearInterval(ping);
  res.end();
});

// ── 공용 보고함 (Neon DB) ──────────────────
function requireDb(req, res, next) {
  if (!DB_AVAILABLE) return res.status(404).json({ error: "공용 보고함(DB)이 설정되어 있지 않습니다." });
  if (!passcodeOk(req.get("x-office-passcode"))) return res.status(401).json({ error: "접속 코드가 맞지 않습니다.", code: "bad_passcode" });
  next();
}
const dbError = (res, err) => {
  console.error("[db]", err);
  res.status(500).json({ error: "DB 처리 중 오류가 났습니다." });
};
app.get("/api/reports", requireDb, async (_req, res) => {
  try {
    res.json({ reports: await listReports() });
  } catch (err) {
    dbError(res, err);
  }
});
app.get("/api/reports/:id", requireDb, async (req, res) => {
  try {
    const r = await getReport(req.params.id);
    if (!r) return res.status(404).json({ error: "보고서를 찾을 수 없습니다." });
    res.json(r);
  } catch (err) {
    dbError(res, err);
  }
});
app.delete("/api/reports/:id", requireDb, async (req, res) => {
  try {
    await deleteReport(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    dbError(res, err);
  }
});

export default app;

// Vercel은 export한 app을 함수로 감싸 실행하므로, 직접 포트를 여는 건 로컬에서만 한다.
if (!ON_VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`\n🏢 AI인터시스 AI 사무실: http://localhost:${PORT}`);
    console.log(HAS_KEY ? `   실제 모드 사용 가능 (${describeLiveConfig().model})` : "   API 키 없음 → 데모 모드만 사용 가능 (.env.example 참고)");
    console.log(DB_AVAILABLE ? "   공용 보고함(Neon DB) 사용" : "   DB 없음 → 보고함은 브라우저에만 저장");
  });
}
