import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { AGENTS } from "./src/agents.js";
import { createJob, getJob } from "./src/jobs.js";
import { runLiveJob, describeLiveConfig } from "./src/orchestrator.js";
import { runDemoJob } from "./src/demo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// API 요금이 드는 서버이므로 기본은 이 PC에서만 접속 가능하게 연다.
const HOST = process.env.HOST || "127.0.0.1";
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(here, "public")));

app.get("/api/config", (_req, res) => {
  res.json({ agents: AGENTS, liveAvailable: HAS_KEY, live: HAS_KEY ? describeLiveConfig() : null });
});

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않습니다. .env의 ANTHROPIC_API_KEY를 확인해 주세요.";
  if (err instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 해당 모델/기능을 쓸 권한이 없습니다.";
  if (err instanceof Anthropic.RateLimitError) return "요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.";
  if (err instanceof Anthropic.BadRequestError) return `잘못된 요청입니다: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Claude API에 연결하지 못했습니다. 네트워크를 확인해 주세요.";
  if (err instanceof Anthropic.APIError) return `API 오류 (${err.status}): ${err.message}`;
  return err?.message || String(err);
}

app.post("/api/jobs", (req, res) => {
  const task = typeof req.body?.task === "string" ? req.body.task.trim() : "";
  if (!task) return res.status(400).json({ error: "업무 내용을 입력해 주세요." });
  if (task.length > 4000) return res.status(400).json({ error: "업무 내용은 4000자 이하로 입력해 주세요." });

  const mode = req.body?.mode === "live" && HAS_KEY ? "live" : "demo";
  const job = createJob(task, mode);
  const run = mode === "live" ? runLiveJob : runDemoJob;
  run(job).catch((err) => {
    console.error(`[job ${job.id}]`, err);
    job.emit("job_error", { message: friendlyError(err) });
  });
  res.json({ id: job.id, mode });
});

app.get("/api/jobs/:id/events", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = job.subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).end();
  if (!job.finished) job.cancel?.();
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(`\n🏢 AI인터시스 AI 사무실: http://localhost:${PORT}`);
  console.log(HAS_KEY ? `   실제 모드 사용 가능 (${describeLiveConfig().model})` : "   API 키 없음 → 데모 모드만 사용 가능 (.env.example 참고)");
});
