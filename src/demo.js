// API 키 없이 사무실 화면을 확인할 수 있는 데모 모드.
// 실제 모드(orchestrator.js)와 똑같은 이벤트를 정해진 대본대로 흘려보낸다.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function type(job, ctx, kind, agent, text, speed = 18) {
  const chunks = text.match(/[\s\S]{1,4}/g) || [];
  for (const c of chunks) {
    if (ctx.cancelled) throw new Error("작업이 중단되었습니다.");
    job.emit(kind, { agent, text: c });
    await sleep(speed);
  }
}

async function worker(job, ctx, agent, callId, instruction, { thinking, searches = [], result }) {
  job.emit("delegate", { from: "manager", to: agent, callId, instruction });
  await sleep(3000); // 팀장이 걸어와 지시를 전달하는 시간
  job.emit("status", { agent, state: "thinking" });
  await type(job, ctx, "thinking", agent, thinking, 22);
  for (const q of searches) {
    job.emit("status", { agent, state: "searching" });
    job.emit("search", { agent, query: q });
    await sleep(1400);
  }
  job.emit("status", { agent, state: "working" });
  await type(job, ctx, "text", agent, result, 8);
  job.emit("report", { from: agent, to: "manager", callId, text: result });
  job.emit("status", { agent, state: "idle" });
  return result;
}

export async function runDemoJob(job) {
  const ctx = { cancelled: false };
  job.cancel = () => (ctx.cancelled = true);
  const topic = job.task.length > 40 ? job.task.slice(0, 40) + "…" : job.task;
  let cost = 0;
  const usage = (agent) => {
    cost += 0.02 + Math.random() * 0.03;
    job.emit("usage", { agent, input: 0, output: 0, cost: 0, totalCost: cost, demo: true });
  };

  job.emit("job_started", { task: job.task, mode: "demo", model: "데모(시뮬레이션)" });
  job.emit("notice", { message: "데모 모드입니다. 실제 AI 대신 정해진 대본으로 흐름만 보여줍니다. .env에 ANTHROPIC_API_KEY를 넣으면 실제 에이전트가 일합니다." });

  job.emit("status", { agent: "manager", state: "thinking" });
  await type(job, ctx, "thinking", "manager",
    `요청: "${topic}". 먼저 사실 조사와 구조 설계가 필요하다. 둘은 서로 독립적이니 리서처와 기획자에게 동시에 맡기자.`);
  job.emit("status", { agent: "manager", state: "working" });
  await type(job, ctx, "text", "manager", "조사와 기획을 동시에 시작하겠습니다. 🔎🧭");
  job.emit("status", { agent: "manager", state: "waiting" });

  const [research, plan] = await Promise.all([
    worker(job, ctx, "researcher", "demo-1", `"${topic}" 관련 최신 동향, 핵심 수치, 사례 3가지를 출처와 함께 조사해 주세요.`, {
      thinking: "검색어를 두세 개로 나눠서 동향과 사례를 따로 찾는 게 좋겠다.",
      searches: [`${topic} 최신 동향`, `${topic} 도입 사례`],
      result: `### 조사 결과\n- **동향**: 관련 시장이 빠르게 성장 중이며 기업 도입이 확대되는 추세 (데모 데이터)\n- **핵심 수치**: 도입 기업의 약 60%가 생산성 향상을 보고 (데모 데이터)\n- **사례**: A사 업무 자동화, B사 고객 응대, C사 문서 작성 지원\n\n*출처: 데모 모드에서는 실제 검색을 하지 않습니다.*`,
    }),
    worker(job, ctx, "planner", "demo-2", `"${topic}"에 대한 문서 구조와 핵심 메시지를 설계해 주세요.`, {
      thinking: "독자가 의사결정자라고 보고, 결론을 앞에 두는 구조로 가자.",
      result: `### 기획안\n| 순서 | 섹션 | 핵심 메시지 |\n|---|---|---|\n| 1 | 요약 | 왜 지금 필요한가 |\n| 2 | 현황 | 시장·경쟁 동향 |\n| 3 | 제안 | 단계별 실행 계획 |\n| 4 | 기대효과 | 정량·정성 효과 |`,
    }),
  ]);
  usage("researcher");
  usage("planner");

  job.emit("status", { agent: "manager", state: "thinking" });
  await type(job, ctx, "thinking", "manager", "조사와 기획이 모였다. 작가에게 두 결과를 넘겨 초안을 쓰게 하자.");
  job.emit("status", { agent: "manager", state: "waiting" });
  const draft = await worker(job, ctx, "writer", "demo-3", `아래 조사·기획을 바탕으로 보고서 초안을 작성해 주세요.\n\n${research}\n\n${plan}`, {
    thinking: "기획안의 4단 구조를 그대로 따르고, 조사 수치를 요약에 녹이자.",
    result: `# ${topic}\n\n## 1. 요약\n지금이 도입 적기입니다. 도입 기업 다수가 생산성 향상을 경험하고 있습니다.\n\n## 2. 현황\n시장은 빠르게 성장 중이며, 선도 기업들은 이미 업무 자동화에 활용하고 있습니다.\n\n## 3. 제안\n1. 파일럿(1개월) → 2. 부서 확대(3개월) → 3. 전사 적용\n\n## 4. 기대효과\n반복 업무 시간 절감, 응대 품질 향상.`,
  });
  usage("writer");

  job.emit("status", { agent: "manager", state: "waiting" });
  await worker(job, ctx, "reviewer", "demo-4", `다음 초안을 검토해 주세요.\n\n${draft}`, {
    thinking: "수치 출처와 실행 계획의 구체성을 중점적으로 보자.",
    result: `### 종합 평가\n구조는 명확함. **7/10**\n\n### 주요 문제\n1. 기대효과에 정량 목표가 없음 → "반복 업무 30% 절감" 같은 목표 제시\n2. 파일럿 성공 기준이 없음 → 평가 지표 추가\n\n### 좋은 점\n- 결론을 앞에 둔 구성이 의사결정자에게 적합`,
  });
  usage("reviewer");

  job.emit("status", { agent: "manager", state: "thinking" });
  await type(job, ctx, "thinking", "manager", "검토 의견을 반영해 최종본을 정리하자.");
  job.emit("status", { agent: "manager", state: "working" });
  const final = `## 최종 보고\n\n${draft}\n\n> **검토 반영**: 기대효과에 "반복 업무 30% 절감" 목표를 추가하고, 파일럿 성공 기준(사용률·만족도·절감 시간)을 정의합니다.\n\n### 팀 작업 요약\n- 이서연 선임연구원: 동향·수치·사례 조사\n- 박준호 책임: 4단 문서 구조 설계\n- 최하은 에디터: 초안 작성 / 정유진 수석: 개선점 2건 제시`;
  await type(job, ctx, "text", "manager", final, 6);
  usage("manager");
  job.emit("status", { agent: "manager", state: "done" });
  job.emit("job_done", { result: final });
}
