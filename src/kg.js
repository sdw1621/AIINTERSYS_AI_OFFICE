// 지식 그래프 메모리: 사람·프로젝트·업무·마감·결정을 노드로, 그 사이를 관계로 쌓는다.
// 처음에는 프로젝트 배정과 단톡방 업무 보드로 뼈대를 만들고(seed), 대화창 메시지가 들어올 때마다 언급된 것들을 이어 붙인다.
// 더 깊은 정리(새 개념·관계)는 지피가 대화창 질문에 답할 때 함께 넣는다.

import { PEOPLE, PROJECTS } from "./projects.js";

export const slug = (type, s) => `${type.toLowerCase()}:${String(s).toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}\-_/.~]/gu, "").slice(0, 60)}`;
const P = (id) => `person:${id}`;
const J = (id) => `project:${id}`;

// 뼈대(층별): 프로젝트 노드·구성원 배정·전략·키워드·협력기관, KRISO는 단톡방 업무 보드(업무·마감·결정)까지
// 노드·관계마다 scope(층의 프로젝트 id)를 붙여 층별 지식이 섞이지 않게 한다. 사람·프로젝트 노드는 공통(all).
export function seedProject(pr, insights) {
  const s = pr.id;
  const nodes = [];
  const edges = [];
  const E = (src, rel, dst) => edges.push({ src, rel, dst, scope: s });
  for (const p of Object.values(PEOPLE)) nodes.push({ id: P(p.id), label: p.name, type: "Person", props: { title: p.title }, scope: "all" });
  nodes.push({ id: J(s), label: pr.short, type: "Project", props: { name: pr.name, floor: pr.floor, title: pr.title || "" }, scope: "all" });
  for (const m of pr.members) {
    E(P(m.id), "WORKS_ON", J(s));
    if (m.duty) { const id = slug("Role", `${s}-${m.duty}`); nodes.push({ id, label: m.duty, type: "Topic", props: { role: m.role }, scope: s }); E(P(m.id), "RESPONSIBLE_FOR", id); E(id, "PART_OF", J(s)); }
  }
  for (const t of pr.strategies || []) { const id = slug("Topic", `${s}-${t}`); nodes.push({ id, label: t, type: "Topic", props: { kind: "전략" }, scope: s }); E(id, "STRATEGY_OF", J(s)); }
  for (const t of pr.tags || []) { const id = slug("Topic", t); nodes.push({ id, label: t, type: "Topic", props: { kind: "기술" }, scope: s }); E(J(s), "USES", id); }
  if (pr.partner) { const id = slug("Org", pr.partner); nodes.push({ id, label: pr.partner, type: "Org", props: {}, scope: s }); E(id, "PARTNER_OF", J(s)); }
  if (pr.group) { const id = slug("Org", pr.group); nodes.push({ id, label: pr.group, type: "Org", props: {}, scope: s }); E(J(s), "MEMBER_OF", id); }
  if (pr.day) { const id = slug("Date", `${s}-${pr.day}`); nodes.push({ id, label: pr.day, type: "Date", props: { kind: "정기 강의" }, scope: s }); E(J(s), "MEETS_ON", id); }
  if (insights) {
    for (const t of insights.tasks || []) {
      const id = slug("Task", t.title);
      nodes.push({ id, label: t.title, type: "Task", props: { status: t.status, detail: t.detail || "" }, scope: s });
      E(P(t.who), "ASSIGNED", id); E(id, "PART_OF", J(s));
    }
    for (const d of insights.deadlines || []) {
      const id = slug("Deadline", `${d.date || "tbd"}-${d.title}`);
      nodes.push({ id, label: d.title, type: "Deadline", props: { date: d.date || "", note: d.note || "" }, scope: s });
      E(id, "DUE_FOR", J(s));
    }
    for (const d of insights.decisions || []) {
      const id = slug("Decision", `${d.date}-${d.text.slice(0, 30)}`);
      nodes.push({ id, label: d.text.length > 40 ? d.text.slice(0, 40) + "…" : d.text, type: "Decision", props: { date: d.date, text: d.text }, scope: s });
      E(id, "DECIDED_IN", J(s));
    }
  }
  return { nodes, edges };
}
export const seedGraph = (insights) => seedProject(PROJECTS.find((p) => p.id === "kriso"), insights);

// 메시지 한 줄에서 아는 것(사람·프로젝트·업무·날짜·주제어)을 찾아 잇는다 — LLM 없이 도는 규칙 기반
export function extractFromText(text, known) {
  const found = new Map();
  const add = (n) => found.set(n.id, { ...n, mention: true });
  const lower = text.toLowerCase();
  for (const p of Object.values(PEOPLE)) if ([p.name, ...(p.chatNames || [])].some((n) => text.includes(n)) || text.includes(p.name.slice(1))) add({ id: P(p.id), label: p.name, type: "Person" });
  for (const pr of PROJECTS) if (pr.match?.test(text) || text.includes(pr.short) || lower.includes(pr.short.toLowerCase())) add({ id: J(pr.id), label: pr.short, type: "Project" });
  for (const n of known) {
    if (n.type !== "Task" && n.type !== "Deadline" && n.type !== "Topic") continue;
    const words = (n.label.match(/[가-힣A-Za-z0-9]{2,}/g) || []).filter((w) => w.length >= 2 && !/^(및|또는|부분|전체)$/.test(w));
    const hit = words.filter((w) => text.includes(w)).length;
    if (hit >= Math.min(2, words.length)) add({ id: n.id, label: n.label, type: n.type });
  }
  for (const m of text.matchAll(/(\d{1,2})\s*(?:\/|월\s*)(\d{1,2})\s*일?/g)) {
    const label = `${Number(m[1])}/${Number(m[2])}`;
    add({ id: slug("Date", label), label, type: "Date" });
  }
  // 주제어: 따옴표·「」로 묶은 말, #태그
  for (const m of text.matchAll(/[「"'#]([^」"'#\s][^」"']{1,24})[」"']?/g)) {
    const label = m[1].trim();
    if (label.length >= 2) add({ id: slug("Topic", label), label, type: "Topic" });
  }
  const nodes = [...found.values()];
  const edges = [];
  const ents = nodes.map((n) => n.id);
  for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++) edges.push({ src: ents[i], rel: "MENTIONED_WITH", dst: ents.at(j) });
  return { nodes, edges };
}
