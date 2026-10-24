// AI 음성 회의: 하루치 단톡방 대화를 담당자별로 나눠 요약하고, 실제 회의처럼 한 사람씩 말하는 대본을 만든다.
// LLM_BASE_URL(OpenAI 호환: 로컬 Ollama·vLLM·LM Studio 등)이 있으면 LLM으로 대본·답변을 만들고,
// 없거나 실패하면 대화 원문에서 핵심 문장을 골라 만드는 규칙 기반 대본으로 대신한다 (크레딧 0원).

import { PEOPLE } from "./projects.js";

const LLM = {
  base: (process.env.LLM_BASE_URL || "").replace(/\/+$/, ""),
  key: process.env.LLM_API_KEY || "",
  model: process.env.LLM_MODEL || "",
};
export const llmEnabled = Boolean(LLM.base && LLM.model);

const KEY_WORDS = /마감|제출|요청|부탁|확인|검토|수정|일정|회의|보고서|완료|공유|정리|작성|발표|자문|계획|결정|드립니다|주세요|해요|할게요|하겠습니다/;
const ORDER = ["leebu", "yang", "shin", "leejh"]; // 진행(미팅일정) → PM → PL → 문서정리
const md = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
const clean = (t) => t.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
const cut = (t, n = 110) => (t.length > n ? t.slice(0, n).replace(/[\s,.·]+\S*$/, "") + "…" : t);

// 담당자별 분류: 말한 횟수 · 공유한 파일 · 핵심 문장(업무 낱말이 있고 너무 짧지 않은 것)
export function digest(messages) {
  const by = {};
  for (const m of messages) {
    if (!m.person || m.kind === "system" || m.kind === "deleted") continue;
    const d = (by[m.person] ??= { count: 0, files: [], lines: [] });
    d.count++;
    if (m.kind === "file") d.files.push(m.text.replace(/^파일:\s*/, ""));
    else if (m.kind === "text") {
      const t = clean(m.text);
      if (t.length < 8) continue;
      const score = (KEY_WORDS.test(t) ? 3 : 0) + Math.min(t.length, 120) / 40 + (/\d+\/\d+|\d+일|\d+시/.test(t) ? 1.5 : 0);
      d.lines.push({ t, score, at: m.t });
    }
  }
  for (const d of Object.values(by)) d.lines.sort((a, b) => b.score - a.score);
  return by;
}

// 규칙 기반 대본: 진행자 인사 → 각자 오늘 말한 핵심 2개 → PM 정리(할 일·마감) → 마무리
export function templateScript(day, messages, insights) {
  const dg = digest(messages);
  const total = messages.filter((m) => m.kind !== "system").length;
  const lines = [];
  const host = "leebu";
  const speakers = ORDER.filter((id) => dg[id]?.count);
  lines.push({ who: host, text: `${md(day)} 단톡방 회의 시작할게요. 오늘 대화는 ${total}건이고, ${speakers.map((id) => PEOPLE[id].name).join(", ")} 님이 말씀하셨어요.` });
  for (const id of speakers) {
    const d = dg[id];
    const top = d.lines.slice(0, 2).sort((a, b) => a.at.localeCompare(b.at));
    if (!top.length && !d.files.length) continue;
    if (top[0]) lines.push({ who: id, text: cut(top[0].t) });
    if (top[1]) lines.push({ who: id, text: cut(top[1].t) });
    if (d.files.length) lines.push({ who: id, text: `자료는 ${d.files.length}개 올렸어요. ${cut(d.files[0], 50)}${d.files.length > 1 ? " 외" : ""}.` });
  }
  const open = (insights?.tasks || []).filter((t) => t.status !== "done");
  const dl = (insights?.deadlines || []).filter((x) => x.date && x.date >= day).slice(0, 2);
  if (open.length || dl.length) {
    const mine = ["shin", "yang", "leejh", "leebu"].map((id) => [id, open.find((t) => t.who === id)]).filter(([, t]) => t);
    const parts = mine.map(([id, t]) => `${PEOPLE[id].name} 님은 ${cut(t.title, 40)}`);
    lines.push({ who: "yang", text: `정리할게요. ${parts.join(", ")} 맡아 주세요.` });
    if (dl.length) lines.push({ who: "yang", text: `마감은 ${dl.map((x) => `${md(x.date)} ${x.title}`).join(", ")}예요.` });
  }
  lines.push({ who: host, text: "오늘 회의는 여기까지요. 수고하셨습니다!" });
  return lines;
}

async function chat(messages, { json = false, max = 900 } = {}) {
  const res = await fetch(`${LLM.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(LLM.key ? { Authorization: `Bearer ${LLM.key}` } : {}) },
    body: JSON.stringify({ model: LLM.model, messages, temperature: 0.4, max_tokens: max, ...(json ? { response_format: { type: "json_object" } } : {}) }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

const ROSTER = () => Object.values(PEOPLE).map((p) => `${p.id}=${p.name}(${p.title})`).join(", ");
const transcript = (messages, limit = 7000) => {
  const out = messages.filter((m) => m.kind !== "system").map((m) => `${m.t.slice(11, 16)} ${PEOPLE[m.person]?.name || m.who}: ${m.kind === "text" ? clean(m.text) : `[${m.kind}] ${clean(m.text)}`}`).join("\n");
  return out.length > limit ? out.slice(-limit) : out;
};

// 대본 만들기: LLM이 있으면 LLM, 실패하면 규칙 기반
export async function meetingScript(day, messages, insights) {
  if (llmEnabled && messages.length) {
    try {
      const raw = await chat([
        { role: "system", content: `너는 회의 대본 작가다. 단톡방 하루치 대화를 바탕으로 팀원들이 실제 회의하듯 말하는 대본을 만든다. 등장인물: ${ROSTER()}. leebu가 진행하고 yang(PM)이 정리한다. 각자 자기가 그날 말한 내용 위주로, 존댓말 구어체 한두 문장씩. 대화에 없는 사실은 지어내지 않는다. JSON {"lines":[{"who":"id","text":"..."}]} 로 8~14줄.` },
        { role: "user", content: `날짜 ${day}\n\n[대화]\n${transcript(messages)}\n\n[업무 보드]\n${JSON.stringify({ tasks: insights?.tasks, deadlines: insights?.deadlines }).slice(0, 2500)}` },
      ], { json: true, max: 1400 });
      const lines = (JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)).lines || [])
        .filter((l) => PEOPLE[l.who] && typeof l.text === "string" && l.text.trim())
        .map((l) => ({ who: l.who, text: cut(l.text.trim(), 160) }));
      if (lines.length >= 3) return { source: "llm", lines };
    } catch (err) {
      console.warn("[meeting] LLM 대본 실패, 규칙 기반으로 대신함:", err.message);
    }
  }
  return { source: "template", lines: templateScript(day, messages, insights) };
}

// 끼어들기: 질문에 가장 관련 있는 사람이 답한다
// 뜻 없는 말(관련·내용·뭐·남았지…)은 빼고 겹침을 센다 — "관련"만 같아서 엉뚱한 답이 나오던 문제
const STOP = new Set("관련 내용 검토 문법 뭐야 뭐가 뭐지 뭐 어떻게 어떤 언제 어디 누구 남았지 남은 있어 있나 알려줘 알려 해줘 정리 확인 부분 지금 이번 그거 이거 저거 그리고 그런데 대한 대해 관한 위한 하는 하기 했어 했나 됐어 되나 요즘 혹시 좀 그냥 진짜 정도 거기 여기 것 거 수 등 및".split(" "));
export const words = (t) => (t.toLowerCase().match(/[가-힣a-z0-9]{2,}/g) || []).map((w) => w.replace(/(은|는|이|가|을|를|에|의|도|요|죠|나요|까요|해요|이야|야|인가|이지|지)$/, "")).filter((w) => w.length >= 2 && !STOP.has(w));
export function overlap(q, t) {
  const a = new Set(words(q));
  return words(t).reduce((n, w) => n + (a.has(w) || [...a].some((x) => x.length >= 2 && w.length >= 2 && (w.includes(x) || x.includes(w))) ? 1 : 0), 0);
}
export async function answer(question, messages, insights) {
  if (llmEnabled) {
    try {
      const raw = await chat([
        { role: "system", content: `팀 회의 중에 신동욱 대표(휴먼)가 끼어들어 질문했다. 등장인물: ${ROSTER()}. 질문과 가장 관련 있는 한 사람(shin 제외)이 단톡방 기록·업무 보드에 근거해 존댓말 구어체 1~3문장으로 답한다. 근거가 없으면 모른다고 하고 확인하겠다고 말한다. JSON {"who":"id","text":"..."}` },
        { role: "user", content: `[질문] ${question}\n\n[최근 대화]\n${transcript(messages, 5000)}\n\n[업무 보드]\n${JSON.stringify(insights || {}).slice(0, 3000)}` },
      ], { json: true, max: 400 });
      const r = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      if (PEOPLE[r.who] && r.who !== "shin" && r.text) return { source: "llm", who: r.who, text: cut(r.text, 200) };
    } catch (err) {
      console.warn("[meeting] LLM 답변 실패:", err.message);
    }
  }
  // 규칙 기반: 업무·마감·결정·대화에서 낱말이 가장 많이 겹치는 것을 찾아 담당자가 답한다
  const cands = [];
  for (const t of insights?.tasks || []) cands.push({ who: t.who, score: overlap(question, `${t.title} ${t.detail || ""}`), text: `${t.title} 건은 ${{ todo: "아직 시작 전이에요", doing: "진행 중이에요", done: "끝났어요" }[t.status] || t.status}.${t.detail ? ` ${cut(t.detail, 70)}` : ""}` });
  for (const d of insights?.deadlines || []) cands.push({ who: "leebu", score: overlap(question, `${d.title} ${d.note || ""} ${d.date ? md(d.date) : ""} 마감 제출 언제`), text: `${d.title}은 ${d.date ? md(d.date) + "까지예요" : "아직 날짜가 안 정해졌어요"}.${d.note ? ` ${cut(d.note, 60)}` : ""}` });
  for (const d of insights?.decisions || []) cands.push({ who: "yang", score: overlap(question, d.text), text: `그건 ${md(d.date)}에 정했어요. ${cut(d.text, 90)}` });
  for (const m of messages.slice(-200)) if (m.kind === "text" && m.person && m.person !== "shin") cands.push({ who: m.person, score: overlap(question, m.text) / (1 + words(m.text).length / 20), text: `단톡방에 남긴 대로예요. ${cut(clean(m.text), 100)}` });
  for (const c of cands) if (!c.text.startsWith("단톡방")) c.score += c.score > 0 ? 0.6 : 0; // 업무 보드 쪽을 조금 더 믿는다
  const best = cands.filter((c) => PEOPLE[c.who] && c.who !== "shin").sort((a, b) => b.score - a.score)[0];
  if (best && best.score >= 1) return { source: "template", who: best.who, text: best.text, score: best.score };
  return { source: "template", who: "yang", text: "그 부분은 단톡방 기록에서 찾지 못했어요. 확인해서 공유드릴게요.", score: 0 };
}
