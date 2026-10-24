// 지피 대화창 빠른 답: 지금 보고 있는 층(프로젝트)의 지식으로만 답한다.
// KRISO(5F)는 단톡방 기록·업무 보드, 다른 층은 프로젝트 정보(과제·전략·협력기관·강의 요일), 그리고 그 층에서 남긴 기록·지피 답.
import { PEOPLE, PROJECTS } from "./projects.js";
import { answer, overlap, words } from "./meeting.js";

const cut = (t, n = 120) => (t.length > n ? t.slice(0, n).replace(/[\s,.·]+\S*$/, "") + "…" : t);
const floorName = (pr) => `${pr.floor}F ${pr.short}`;

function projectFacts(pr) {
  const f = [];
  if (pr.title) f.push({ text: `${pr.short} 과제는 「${pr.title}」 이거야.`, key: `${pr.title} 과제 주제 제목 무엇 목표` });
  if (pr.summary) f.push({ text: cut(pr.summary, 160), key: `${pr.summary} 개요 요약 소개` });
  if (pr.strategies?.length) f.push({ text: `${pr.short} 전략은 ${pr.strategies.length}가지야: ${pr.strategies.join(" / ")}.`, key: "전략 실행계획 전체 목록 몇 가지" });
  for (const s of pr.strategies || []) f.push({ text: `${pr.short} 실행 전략 중 하나는 「${s}」 이거야.`, key: `${s}` });
  if (pr.partner) f.push({ text: `협력 기관은 ${pr.partner}이야.`, key: `${pr.partner} 협력 기관 운영 교육원 파트너` });
  if (pr.day) f.push({ text: `수업은 ${pr.day}이야.`, key: `${pr.day} 요일 수업 강의 일정 언제` });
  if (pr.group) f.push({ text: `${pr.group} 중 한 곳이야.`, key: `${pr.group} 그룹 울산` });
  if (pr.tags?.length) f.push({ text: `쓰는 기술은 ${pr.tags.join(", ")}야.`, key: `${pr.tags.join(" ")} 기술 스택 도구` });
  f.push({ text: `${pr.short} 담당: ${pr.members.map((m) => `${PEOPLE[m.id]?.name} ${m.role}${m.duty ? `(${m.duty})` : ""}`).join(", ")}.`, key: `담당 누구 구성원 멤버 역할 ${pr.members.map((m) => `${PEOPLE[m.id]?.name} ${m.role} ${m.duty || ""}`).join(" ")}` });
  return f;
}

// 그 층에서 전에 남긴 말·지피 답에서 찾기
function fromHistory(q, history) {
  let best = null;
  for (const m of history) {
    if (m.kind === "quick") continue;
    const sc = overlap(q, m.text) / (1 + words(m.text).length / 25);
    if (sc > (best?.score || 0)) best = { score: sc, text: m.role === "user" ? `전에 남겨 두신 기록이 있어: "${cut(m.text, 90)}"` : `지난번 지피 답이야. ${cut(m.text, 140)}` };
  }
  return best;
}

export async function quickAnswer(q, project, { chat, insights, history }) {
  const pr = PROJECTS.find((p) => p.id === project);
  const prev = fromHistory(q, history);
  if (project === "kriso") {
    const a = await answer(q, chat, insights);
    if (a.source === "llm") return a;
    if (prev && prev.score > (a.score || 0)) return { source: "template", who: "jipi", text: prev.text };
    return a.score >= 1 ? a : { source: "template", who: "jipi", text: `5F KRISO 단톡방·업무 보드에서는 "${cut(q, 30)}" 관련 내용을 못 찾았어. 지피가 더 찾아보고 답 달아 줄게.` };
  }
  const pool = (project === "all" ? PROJECTS : [pr]).flatMap((p) => projectFacts(p).map((f) => ({ ...f, p })));
  let best = null;
  for (const f of pool) {
    const sc = overlap(q, f.key) + overlap(q, f.text) * 0.5 + (project === "all" && overlap(q, `${f.p.short} ${f.p.name}`) ? 1.5 : 0);
    if (sc > (best?.score || 0)) best = { ...f, score: sc };
  }
  if (prev && prev.score >= (best?.score || 0) && prev.score >= 1) return { source: "template", who: "jipi", text: prev.text };
  if (best && best.score >= 1) return { source: "template", who: "jipi", text: project === "all" ? `[${floorName(best.p)}] ${best.text}` : best.text };
  const where = project === "all" ? "타워 전체" : floorName(pr);
  return { source: "template", who: "jipi", text: `${where} 기록에서는 "${cut(q, 30)}" 관련 내용을 못 찾았어. 지피가 확인해서 답 달아 줄게.` };
}
