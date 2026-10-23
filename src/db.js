// Neon(Postgres) 보고함 저장소.
// Vercel에서 Neon을 연결하면 DATABASE_URL(또는 POSTGRES_URL)이 자동으로 들어온다.
// 값이 없으면 DB 기능은 꺼지고, 화면은 브라우저 저장소(보고함)만 쓴다.

import { neon } from "@neondatabase/serverless";

const URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const sql = URL ? neon(URL) : null;
let ready = null;

export const dbEnabled = Boolean(sql);

function ensureTable() {
  ready ??= sql`
    CREATE TABLE IF NOT EXISTS office_reports (
      id          TEXT PRIMARY KEY,
      task        TEXT NOT NULL,
      mode        TEXT NOT NULL,
      model       TEXT,
      status      TEXT NOT NULL,
      started_at  TIMESTAMPTZ NOT NULL,
      ended_at    TIMESTAMPTZ NOT NULL,
      cost        NUMERIC(10, 4) DEFAULT 0,
      delegations INT DEFAULT 0,
      searches    INT DEFAULT 0,
      materials   JSONB DEFAULT '[]'::jsonb,
      result      TEXT,
      timeline    JSONB DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`.catch((err) => {
    ready = null; // 다음 요청에서 다시 시도
    throw err;
  });
  return ready;
}

// 작업 이벤트에서 보고서 한 건을 만든다. 글자 단위 이벤트(생각·작성)는 빼고 타임라인만 남긴다.
export function reportFromJob(job) {
  const ev = job.events;
  const t0 = ev[0]?.t || job.createdAt;
  const done = ev.find((e) => e.type === "job_done");
  const lastUsage = [...ev].reverse().find((e) => e.type === "usage");
  const timeline = ev
    .filter((e) => ["status", "delegate", "report", "search", "read"].includes(e.type))
    .map((e) => {
      const x = { type: e.type, t: e.t - t0 };
      for (const k of ["agent", "state", "from", "to", "query", "name"]) if (e[k] !== undefined) x[k] = e[k];
      if (e.type === "report") x.chars = e.text?.length || 0;
      return x;
    });
  return {
    id: job.id,
    task: job.task,
    mode: job.mode,
    model: ev.find((e) => e.type === "job_started")?.model || "",
    status: done ? "done" : "error",
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date(ev.at(-1)?.t || Date.now()).toISOString(),
    cost: done?.totalCost ?? lastUsage?.totalCost ?? 0,
    delegations: ev.filter((e) => e.type === "delegate").length,
    searches: ev.filter((e) => e.type === "search").length,
    materials: ev.find((e) => e.type === "job_started")?.materials || [],
    result: done?.result || "",
    timeline,
  };
}

export async function saveReport(r) {
  await ensureTable();
  await sql`
    INSERT INTO office_reports (id, task, mode, model, status, started_at, ended_at, cost, delegations, searches, materials, result, timeline)
    VALUES (${r.id}, ${r.task}, ${r.mode}, ${r.model}, ${r.status}, ${r.startedAt}, ${r.endedAt}, ${r.cost}, ${r.delegations}, ${r.searches},
            ${JSON.stringify(r.materials)}::jsonb, ${r.result}, ${JSON.stringify(r.timeline)}::jsonb)
    ON CONFLICT (id) DO NOTHING`;
}

const toClient = (row) => ({
  id: row.id,
  task: row.task,
  mode: row.mode,
  model: row.model,
  status: row.status,
  startedAt: new Date(row.started_at).getTime(),
  durationMs: new Date(row.ended_at).getTime() - new Date(row.started_at).getTime(),
  cost: Number(row.cost) || 0,
  costDemo: row.mode !== "live",
  delegations: row.delegations,
  searches: row.searches,
  materials: row.materials || [],
  ...(row.result !== undefined && { result: row.result }),
  ...(row.timeline !== undefined && { timeline: row.timeline }),
  source: "db",
});

export async function listReports(limit = 50) {
  await ensureTable();
  const rows = await sql`
    SELECT id, task, mode, model, status, started_at, ended_at, cost, delegations, searches, materials
    FROM office_reports ORDER BY started_at DESC LIMIT ${limit}`;
  return rows.map(toClient);
}

export async function getReport(id) {
  await ensureTable();
  const rows = await sql`SELECT * FROM office_reports WHERE id = ${id}`;
  return rows[0] ? toClient(rows[0]) : null;
}

export async function deleteReport(id) {
  await ensureTable();
  await sql`DELETE FROM office_reports WHERE id = ${id}`;
}
