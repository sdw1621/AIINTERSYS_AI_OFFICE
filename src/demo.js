// API 키 없이 타워 화면을 확인할 수 있는 데모 모드.
// 실제 모드(orchestrator.js)와 똑같은 이벤트(위임·자료 읽기·검색·보고)를 정해진 대본대로 흘려보낸다.
// 첨부 자료가 있으면 파일 이름과 앞부분을 대본에 넣어 보여 준다 (분석 자체는 하지 않는다).

import { materialIndex } from "./materials.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function type(job, ctx, kind, agent, text, speed = 14) {
  const chunks = text.match(/[\s\S]{1,5}/g) || [];
  for (const c of chunks) {
    if (ctx.cancelled) throw new Error("작업이 중단되었습니다.");
    job.emit(kind, { agent, text: c });
    await sleep(speed);
  }
}

function cost(job, ctx, agent) {
  ctx.cost += 0.02 + Math.random() * 0.03;
  job.emit("usage", { agent, input: 0, output: 0, cost: 0, totalCost: ctx.cost, demo: true });
}

// 한 사람의 일: (지시 받기) → 생각 → 자료 읽기/검색 → 작성 → 보고
async function work(job, ctx, from, id, instruction, s) {
  job.emit("delegate", { from, to: id, callId: `demo-${++ctx.n}`, instruction });
  await sleep(s.walk ?? 2600); // 상사가 걸어와(필요하면 엘리베이터를 타고) 지시를 전달하는 시간
  job.emit("status", { agent: id, state: "thinking" });
  await type(job, ctx, "thinking", id, s.thinking, 18);
  for (const name of s.reads || []) {
    job.emit("status", { agent: id, state: "searching" });
    job.emit("read", { agent: id, name, part: 1, parts: 1 });
    await sleep(900);
  }
  for (const q of s.searches || []) {
    job.emit("status", { agent: id, state: "searching" });
    job.emit("search", { agent: id, query: q });
    await sleep(1100);
  }
  let result = s.result;
  if (s.members) {
    job.emit("status", { agent: id, state: "waiting" });
    const outs = await Promise.all(s.members.map((m) => work(job, ctx, id, m.id, m.instruction, m)));
    job.emit("status", { agent: id, state: "thinking" });
    await type(job, ctx, "thinking", id, "팀원 결과를 하나로 묶자.", 18);
    result = typeof s.result === "function" ? s.result(outs) : s.result;
  }
  job.emit("status", { agent: id, state: "working" });
  await type(job, ctx, "text", id, result, 5);
  cost(job, ctx, id);
  job.emit("report", { from: id, to: from, callId: `demo-r${ctx.n}`, text: result });
  job.emit("status", { agent: id, state: "idle" });
  return result;
}

export async function runDemoJob(job) {
  const ctx = { cancelled: false, cost: 0, n: 0 };
  job.cancel = () => (ctx.cancelled = true);
  const topic = job.task.length > 40 ? job.task.slice(0, 40) + "…" : job.task;
  const mats = job.materials || [];
  const names = mats.map((m) => m.name);
  const matLine = names.length ? `첨부 자료 ${names.length}건(${names.join(", ")})` : "첨부 자료 없음";

  job.emit("job_started", { id: job.id, task: job.task, mode: "demo", model: "데모(시뮬레이션)", materials: materialIndex(mats) });
  job.emit("notice", { message: "데모 모드입니다. 실제 AI 대신 정해진 대본으로 흐름만 보여줍니다. 서버에 ANTHROPIC_API_KEY를 넣으면 실제로 자료를 읽고 일합니다." });

  job.emit("status", { agent: "manager", state: "thinking" });
  await type(job, ctx, "thinking", "manager",
    `요청: "${topic}". ${matLine}. 비서에게 자료 정리를, 리서치팀과 기획팀에는 조사와 설계를 동시에 맡기자.`);
  job.emit("status", { agent: "manager", state: "working" });
  await type(job, ctx, "text", "manager", "자료 정리·조사·기획을 동시에 시작합시다. 각 팀장님 부탁드립니다. 🏢");
  job.emit("status", { agent: "manager", state: "waiting" });

  const briefRows = mats.length
    ? mats.map((m) => `| ${m.name} | ${m.kindLabel} | ${(m.preview || "").slice(0, 60)}… |`).join("\n")
    : "| (첨부 없음) | - | - |";

  const [brief, research, plan] = await Promise.all([
    work(job, ctx, "manager", "secretary", `첨부 자료를 읽고 자료별 핵심을 표로 정리해 주세요.`, {
      thinking: "자료마다 목적·핵심 내용을 한 줄씩 뽑아 표로 만들자.",
      reads: names.slice(0, 4),
      result: `### 자료 브리핑\n${matLine}을 확인했습니다.\n\n| 자료 | 종류 | 앞부분 |\n|---|---|---|\n${briefRows}\n\n*데모 모드에서는 자료 앞부분만 보여 줍니다.*`,
    }),
    work(job, ctx, "manager", "researcher", `"${topic}" 관련 동향·수치·사례를 조사해 주세요.`, {
      thinking: "수치는 오태윤 연구원, 사례는 문하린 연구원에게 나누자.",
      members: [
        { id: "data_researcher", instruction: `"${topic}" 관련 시장 규모·통계 수치를 표로 정리해 주세요.`, thinking: "공신력 있는 통계부터 찾자.", searches: [`${topic} 시장 규모`], result: `| 지표 | 값 | 출처 |\n|---|---|---|\n| 도입 기업 생산성 향상 응답 | 약 60% | 데모 데이터 |\n| 관련 정부 지원 사업 | 확대 추세 | 데모 데이터 |` },
        { id: "case_researcher", instruction: `"${topic}" 관련 도입 사례 3가지를 찾아 주세요.`, thinking: "제조 현장 사례 위주로 보자.", searches: [`${topic} 도입 사례`], result: `- A사: 품질 데이터 자동 분석 (데모)\n- B사: 견적·원가 예측 (데모)\n- C사: 문서·성적서 자동 작성 (데모)` },
      ],
      result: (outs) => `### 리서치팀 결과\n**주요 수치**\n${outs[0]}\n\n**사례**\n${outs[1]}\n\n— 팀원 기여: 오태윤(수치), 문하린(사례)`,
    }),
    work(job, ctx, "manager", "planner", `"${topic}"의 문서 구조와 실행계획을 설계해 주세요.`, {
      thinking: "기능 설계는 류건우, 일정·KPI는 홍다인에게.",
      members: [
        { id: "service_planner", instruction: "핵심 기능을 표로 설계해 주세요.", thinking: "입력·처리·출력으로 쪼개자.", reads: names.slice(0, 1), result: `| 기능 | 입력 | 출력 | 우선순위 |\n|---|---|---|---|\n| 데이터 자동 분류 | 현장 문서 | 정리된 DB | 1 |\n| 분석·예측 | 실적 데이터 | 예측값 | 2 |\n| 보고서 자동 작성 | 분석 결과 | 문서 초안 | 3 |` },
        { id: "pm", instruction: "단계별 일정과 KPI를 정리해 주세요.", thinking: "PBL → PoC → 확산 3단계로.", result: `| 단계 | 기간 | KPI |\n|---|---|---|\n| PBL | 1개월 | 과제 정의 완료 |\n| PoC | 2개월 | 업무시간 30% 절감 |\n| 확산 | 3개월 | 2개 부서 적용 |` },
      ],
      result: (outs) => `### 기획팀 결과\n**기능 설계**\n${outs[0]}\n\n**실행계획**\n${outs[1]}\n\n— 팀원 기여: 류건우(기능), 홍다인(일정·KPI)`,
    }),
  ]);

  job.emit("status", { agent: "manager", state: "thinking" });
  await type(job, ctx, "thinking", "manager", "자료 정리·조사·기획이 모였다. 콘텐츠팀에 초안을 맡기자.");
  job.emit("status", { agent: "manager", state: "waiting" });
  const draft = await work(job, ctx, "manager", "writer", `아래 결과를 바탕으로 보고서 초안을 써 주세요.\n\n${brief}\n\n${research}\n\n${plan}`, {
    thinking: "본문은 장예린, 요약·헤드라인은 백승우에게.",
    members: [
      { id: "editor", instruction: "보고서 본문을 작성해 주세요.", thinking: "결론부터 쓰는 4단 구성으로.", result: `## 1. 요약\n지금이 AX 도입 적기입니다.\n\n## 2. 현황\n현장 데이터가 분산되어 반복 업무가 많습니다.\n\n## 3. 제안\n데이터 정리 → 분석·예측 → 문서 자동화 순서로 추진합니다.\n\n## 4. 기대효과\n반복 업무 시간 절감과 판단 근거 확보.` },
      { id: "copywriter", instruction: "핵심 요약 3줄과 헤드라인을 만들어 주세요.", thinking: "한 줄로 기억되게.", result: `**헤드라인**: 흩어진 현장 데이터를, 바로 쓰는 AI 업무비서로\n- 데이터 정리부터 자동화까지 3단계\n- PoC로 효과를 먼저 증명\n- 현장 담당자가 직접 쓰는 AX` },
    ],
    result: (outs) => `# ${topic}\n\n${outs[1]}\n\n${outs[0]}\n\n— 팀원 기여: 장예린(본문), 백승우(요약·카피)`,
  });

  job.emit("status", { agent: "manager", state: "waiting" });
  await work(job, ctx, "manager", "reviewer", `다음 초안을 검토해 주세요.\n\n${draft}`, {
    thinking: "사실 검증은 권태현, 문장·용어는 노은채에게.",
    members: [
      { id: "fact_checker", instruction: "수치와 근거를 원자료와 대조해 주세요.", thinking: "자료에 있는 내용인지부터 보자.", reads: names.slice(0, 2), result: `| 항목 | 판정 | 수정안 |\n|---|---|---|\n| 업무시간 30% 절감 | 확인불가 | "목표치"로 표기 |\n| 도입 기업 60% | 데모 데이터 | 출처 명시 |` },
      { id: "proofreader", instruction: "용어와 문장을 다듬어 주세요.", thinking: "AX·AI 용어 표기를 통일하자.", result: `- "AI 업무비서" / "AI 에이전트" 혼용 → "AI 에이전트"로 통일\n- 요약 첫 문장에 대상(기업명)을 넣으면 더 분명해집니다.` },
    ],
    result: (outs) => `### 종합 평가\n구조는 명확함. **7/10**\n\n### 주요 문제\n1. 기대효과 수치가 목표인지 실적인지 불분명 → "목표치"로 표기\n2. 용어 혼용 → "AI 에이전트"로 통일\n\n**검증표**\n${outs[0]}\n\n**교정 의견**\n${outs[1]}\n\n— 팀원 기여: 권태현(검증), 노은채(교정)`,
  });

  job.emit("status", { agent: "manager", state: "thinking" });
  await type(job, ctx, "thinking", "manager", "검토 의견을 반영해 최종본을 정리하자.");
  job.emit("status", { agent: "manager", state: "working" });
  const final = `## 최종 보고\n\n${draft}\n\n> **검토 반영**: 기대효과 수치는 "목표치"로 표기하고, 용어를 "AI 에이전트"로 통일했습니다.\n\n### 팀 작업 요약\n- 총괄 본부: 윤서아 비서 자료 정리(${names.length}건)\n- 리서치팀(이서연): 수치·사례 조사 / 기획팀(박준호): 기능·실행계획\n- 콘텐츠팀(최하은): 초안 / 품질검토팀(정유진): 검증·교정`;
  await type(job, ctx, "text", "manager", final, 4);
  cost(job, ctx, "manager");
  job.emit("status", { agent: "manager", state: "done" });
  job.emit("job_done", { result: final, totalCost: ctx.cost });
}
