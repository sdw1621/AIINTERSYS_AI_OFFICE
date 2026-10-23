// Neon(Postgres): 보고함 + 캘린더 일정 동기화본.
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

// ── 캘린더 일정 동기화본 (iCal 주소가 없을 때 쓰는 일정) ──
let eventsReady = null;
function ensureEvents() {
  eventsReady ??= sql`
    CREATE TABLE IF NOT EXISTS office_events (
      id          TEXT PRIMARY KEY,
      project     TEXT NOT NULL,
      title       TEXT NOT NULL,
      all_day     BOOLEAN NOT NULL DEFAULT false,
      start_at    TEXT NOT NULL,
      end_at      TEXT NOT NULL,
      location    TEXT,
      description TEXT,
      synced_at   TIMESTAMPTZ DEFAULT now()
    )`.catch((err) => {
    eventsReady = null;
    throw err;
  });
  return eventsReady;
}

export async function listEvents() {
  await ensureEvents();
  const rows = await sql`SELECT * FROM office_events ORDER BY start_at`;
  const { normalize } = await import("./calendar.js");
  const events = rows
    .map((r) => normalize({ id: r.id, title: r.title, allDay: r.all_day, start: r.start_at, end: r.end_at, location: r.location || "", description: r.description || "" }))
    .filter(Boolean);
  const syncedAt = rows.reduce((m, r) => (!m || r.synced_at > m ? r.synced_at : m), null);
  return { events, syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null };
}
