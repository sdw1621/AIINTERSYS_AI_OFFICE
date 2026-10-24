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

// ── 단톡방 대화 누적 (같은 시각·보낸 사람·내용은 한 번만) ──
let chatReady = null;
function ensureChat() {
  chatReady ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS office_chat (
        id         BIGSERIAL PRIMARY KEY,
        room       TEXT NOT NULL,
        t          TIMESTAMPTZ NOT NULL,
        who        TEXT NOT NULL,
        person     TEXT,
        kind       TEXT NOT NULL,
        text       TEXT NOT NULL,
        seq        INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS office_chat_uniq ON office_chat (room, t, who, md5(text))`;
    await sql`CREATE INDEX IF NOT EXISTS office_chat_room_t ON office_chat (room, t DESC, seq DESC)`;
    await sql`
      CREATE TABLE IF NOT EXISTS office_insights (
        room       TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`;
  })().catch((err) => {
    chatReady = null;
    throw err;
  });
  return chatReady;
}

export async function importChat(room, messages) {
  await ensureChat();
  let inserted = 0;
  for (let i = 0; i < messages.length; i += 400) {
    const part = messages.slice(i, i + 400);
    const rows = await sql`
      INSERT INTO office_chat (room, t, who, person, kind, text, seq)
      SELECT ${room}, x.t::timestamptz, x.who, x.person, x.kind, x.text, x.seq
      FROM jsonb_to_recordset(${JSON.stringify(part.map((m, k) => ({ t: m.t, who: m.who || "", person: m.person, kind: m.kind, text: m.text, seq: i + k })))}::jsonb)
        AS x(t text, who text, person text, kind text, text text, seq int)
      ON CONFLICT (room, t, who, md5(text)) DO NOTHING
      RETURNING id`;
    inserted += rows.length;
  }
  const [{ total, first, last }] = await sql`SELECT count(*)::int AS total, min(t) AS first, max(t) AS last FROM office_chat WHERE room = ${room}`;
  return { inserted, total, first, last };
}

export async function listChat(room, { limit = 60, before = null, day = null } = {}) {
  await ensureChat();
  const rows = day
    ? await sql`SELECT t, who, person, kind, text FROM office_chat WHERE room = ${room} AND (t AT TIME ZONE 'Asia/Seoul')::date = ${day}::date ORDER BY t, seq, id`
    : before
      ? await sql`SELECT t, who, person, kind, text FROM office_chat WHERE room = ${room} AND t < ${before} ORDER BY t DESC, seq DESC, id DESC LIMIT ${limit}`
      : await sql`SELECT t, who, person, kind, text FROM office_chat WHERE room = ${room} ORDER BY t DESC, seq DESC, id DESC LIMIT ${limit}`;
  const list = day ? rows : rows.reverse();
  return list.map((r) => ({ ...r, t: new Date(r.t).toISOString() }));
}

export async function chatDays(room) {
  await ensureChat();
  const rows = await sql`
    SELECT (t AT TIME ZONE 'Asia/Seoul')::date::text AS day, count(*)::int AS n
    FROM office_chat WHERE room = ${room} AND kind <> 'system' GROUP BY 1 ORDER BY 1 DESC`;
  const [{ total }] = await sql`SELECT count(*)::int AS total FROM office_chat WHERE room = ${room}`;
  return { days: rows, total };
}

export async function allChat(room) {
  await ensureChat();
  return sql`SELECT to_char(t AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI') AS kst, who, person, kind, text FROM office_chat WHERE room = ${room} ORDER BY t, seq, id`;
}

export async function getInsights(room) {
  await ensureChat();
  const rows = await sql`SELECT data, updated_at FROM office_insights WHERE room = ${room}`;
  return rows[0] ? { ...rows[0].data, updatedAt: new Date(rows[0].updated_at).toISOString() } : null;
}

// ── 지피 대화창 + 지식 그래프(KG) 메모리 ──
// 타워의 대화창 메시지를 쌓고(office_bot), 메시지에서 사람·프로젝트·업무·날짜를 뽑아 노드·관계로 누적한다(office_kg_*).
let botReady = null;
function ensureBot() {
  botReady ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS office_bot (
        id          BIGSERIAL PRIMARY KEY,
        role        TEXT NOT NULL,              -- user | bot
        who         TEXT NOT NULL,              -- shin(신대표님) | jipi | 팀원 id
        text        TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'text', -- text | quick(빠른 답) | answer(지피 답)
        status      TEXT NOT NULL DEFAULT 'done', -- user 메시지: pending(지피 답 대기) | done
        reply_to    BIGINT,
        created_at  TIMESTAMPTZ DEFAULT now()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS office_kg_nodes (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        type        TEXT NOT NULL,
        props       JSONB NOT NULL DEFAULT '{}'::jsonb,
        mentions    INT NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT now(),
        updated_at  TIMESTAMPTZ DEFAULT now()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS office_kg_edges (
        src         TEXT NOT NULL,
        rel         TEXT NOT NULL,
        dst         TEXT NOT NULL,
        weight      INT NOT NULL DEFAULT 1,
        source_msg  BIGINT,
        created_at  TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (src, rel, dst)
      )`;
  })().catch((err) => {
    botReady = null;
    throw err;
  });
  return botReady;
}

export async function listBot({ after = 0, limit = 80 } = {}) {
  await ensureBot();
  const rows = after
    ? await sql`SELECT * FROM office_bot WHERE id > ${after} ORDER BY id LIMIT ${limit}`
    : await sql`SELECT * FROM (SELECT * FROM office_bot ORDER BY id DESC LIMIT ${limit}) x ORDER BY id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), reply_to: r.reply_to && Number(r.reply_to), created_at: new Date(r.created_at).toISOString() }));
}

export async function addBot({ role, who, text, kind = "text", status = "done", replyTo = null }) {
  await ensureBot();
  const [r] = await sql`INSERT INTO office_bot (role, who, text, kind, status, reply_to) VALUES (${role}, ${who}, ${text}, ${kind}, ${status}, ${replyTo}) RETURNING id, created_at`;
  if (replyTo && kind === "answer") await sql`UPDATE office_bot SET status = 'done' WHERE id = ${replyTo}`;
  return { id: Number(r.id), created_at: new Date(r.created_at).toISOString() };
}

// 노드·관계 누적: 같은 노드는 언급 횟수, 같은 관계는 가중치가 올라간다
export async function upsertKG(nodes = [], edges = [], sourceMsg = null) {
  await ensureBot();
  // 한 번에 같은 id가 두 번 들어가면 ON CONFLICT가 실패하므로 미리 합친다
  const nm = new Map();
  for (const n of nodes) if (n?.id && n.label && n.type) nm.set(n.id, { ...nm.get(n.id), ...n, mention: n.mention || nm.get(n.id)?.mention });
  nodes = [...nm.values()];
  edges = [...new Map(edges.filter((e) => e?.src && e.rel && e.dst && e.src !== e.dst).map((e) => [`${e.src}|${e.rel}|${e.dst}`, { src: e.src, rel: e.rel, dst: e.dst }])).values()];
  if (nodes.length) {
    await sql`
      INSERT INTO office_kg_nodes (id, label, type, props, mentions)
      SELECT x.id, x.label, x.type, COALESCE(x.props, '{}'::jsonb), x.m
      FROM jsonb_to_recordset(${JSON.stringify(nodes.map((n) => ({ id: n.id, label: n.label, type: n.type, props: n.props || {}, m: n.mention ? 1 : 0 })))}::jsonb)
        AS x(id text, label text, type text, props jsonb, m int)
      ON CONFLICT (id) DO UPDATE SET mentions = office_kg_nodes.mentions + EXCLUDED.mentions,
        props = office_kg_nodes.props || EXCLUDED.props, updated_at = now()`;
  }
  if (edges.length) {
    await sql`
      INSERT INTO office_kg_edges (src, rel, dst, source_msg)
      SELECT x.src, x.rel, x.dst, ${sourceMsg}::bigint
      FROM jsonb_to_recordset(${JSON.stringify(edges)}::jsonb) AS x(src text, rel text, dst text)
      WHERE EXISTS (SELECT 1 FROM office_kg_nodes WHERE id = x.src) AND EXISTS (SELECT 1 FROM office_kg_nodes WHERE id = x.dst)
      ON CONFLICT (src, rel, dst) DO UPDATE SET weight = office_kg_edges.weight + 1`;
  }
}

export async function getKG() {
  await ensureBot();
  const [nodes, edges] = await Promise.all([sql`SELECT id, label, type, props, mentions FROM office_kg_nodes ORDER BY mentions DESC, id`, sql`SELECT src, rel, dst, weight FROM office_kg_edges`]);
  return { nodes, edges };
}

export async function kgCount() {
  await ensureBot();
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM office_kg_nodes`;
  return n;
}
