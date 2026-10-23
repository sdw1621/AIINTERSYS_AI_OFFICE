import Anthropic from "@anthropic-ai/sdk";
import { MANAGER_ID, SYSTEM_PROMPTS, getAgent, subordinates } from "./agents.js";
import { materialIndex, readMaterial } from "./materials.js";

// ── 설정 (.env / Vercel 환경변수로 덮어쓸 수 있음) ──────────────
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const MANAGER_EFFORT = process.env.MANAGER_EFFORT || "high"; // 본부장
const LEAD_EFFORT = process.env.LEAD_EFFORT || "medium"; // 팀장
const WORKER_EFFORT = process.env.WORKER_EFFORT || "medium"; // 팀원
const MAX_MANAGER_TURNS = Number(process.env.MAX_MANAGER_TURNS || 8);
const MAX_LEAD_TURNS = Number(process.env.MAX_LEAD_TURNS || 5);
const MAX_WORKER_TURNS = 8; // 자료 읽기·웹 검색 일시정지까지 포함한 한 사람의 최대 왕복 수
const ENABLE_WEB_SEARCH = process.env.ENABLE_WEB_SEARCH !== "false";
// 안전 분류기가 요청을 거절하면 서버에서 대체 모델로 자동 재시도한다.
const ENABLE_FALLBACK = process.env.ENABLE_FALLBACK !== "false";

// Claude Opus 5 요금 (USD / 1M tokens) - 화면에 표시할 대략적인 비용 계산용
const PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

// API 키가 없어도 서버(데모 모드)는 뜰 수 있도록 클라이언트는 처음 쓸 때 만든다.
let client;
function getClient() {
  return (client ??= new Anthropic());
}

const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 5 };

function delegateTool(ids) {
  return {
    name: "delegate_task",
    description:
      "부하 직원 한 명에게 업무를 맡기고 그 결과를 받는다. 서로 독립적인 업무는 같은 응답에서 여러 번 호출하면 동시에 진행된다. " +
      "부하 직원은 상사가 받은 요청이나 다른 사람의 결과를 볼 수 없으므로, instruction에 필요한 배경·형식·읽을 자료 이름·앞선 결과의 핵심을 모두 담아야 한다.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ids,
          description: ids.map((id) => `${id}=${getAgent(id).name} ${getAgent(id).role}`).join(", "),
        },
        instruction: { type: "string", description: "구체적인 업무 지시. 목적, 범위, 결과물 형식, 읽을 자료, 참고할 앞선 결과를 포함한다." },
      },
      required: ["agent", "instruction"],
    },
  };
}

function materialTool(materials) {
  return {
    name: "read_material",
    description:
      "사용자가 첨부한 자료를 읽는다. 긴 자료는 여러 부분(part)으로 나뉘어 있으니 필요한 만큼 이어서 읽는다. " +
      "자료 목록: " + materials.map((m) => `"${m.name}"(${m.parts}부분)`).join(", "),
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", enum: materials.map((m) => m.name), description: "읽을 자료의 파일 이름" },
        part: { type: "integer", minimum: 1, description: "읽을 부분 번호 (1부터). 생략하면 1" },
      },
      required: ["name"],
    },
  };
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// ── 한 번의 호출을 스트리밍하면서 화면용 이벤트를 내보낸다 ──
async function streamAgent(job, ctx, agentId, params) {
  const request = {
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: "adaptive", display: "summarized" },
    system: SYSTEM_PROMPTS[agentId],
    ...params,
  };
  if (ENABLE_FALLBACK) {
    request.betas = ["server-side-fallback-2026-07-01"];
    request.fallbacks = "default";
  }

  const stream = getClient().beta.messages.stream(request);
  const blockTypes = {};
  const serverToolInput = {};

  for await (const event of stream) {
    if (ctx.cancelled) {
      stream.abort();
      throw new Error("작업이 중단되었습니다.");
    }
    switch (event.type) {
      case "content_block_start": {
        const type = event.content_block.type;
        blockTypes[event.index] = type;
        if (type === "thinking") job.emit("status", { agent: agentId, state: "thinking" });
        else if (type === "text") job.emit("status", { agent: agentId, state: "working" });
        else if (type === "server_tool_use") {
          serverToolInput[event.index] = "";
          job.emit("status", { agent: agentId, state: "searching" });
        } else if (type === "fallback") {
          job.emit("notice", { agent: agentId, message: "안전 정책으로 대체 모델이 이어서 처리합니다." });
        }
        break;
      }
      case "content_block_delta": {
        const d = event.delta;
        if (d.type === "thinking_delta") job.emit("thinking", { agent: agentId, text: d.thinking });
        else if (d.type === "text_delta") job.emit("text", { agent: agentId, text: d.text });
        else if (d.type === "input_json_delta" && event.index in serverToolInput) serverToolInput[event.index] += d.partial_json;
        break;
      }
      case "content_block_stop": {
        if (blockTypes[event.index] === "server_tool_use") {
          let query = "";
          try {
            query = JSON.parse(serverToolInput[event.index] || "{}").query || "";
          } catch {
            /* 검색어 표시는 부가 기능이므로 파싱 실패는 무시 */
          }
          job.emit("search", { agent: agentId, query });
        }
        break;
      }
    }
  }

  const message = await stream.finalMessage();
  recordUsage(job, ctx, agentId, message.usage);
  return message;
}

function recordUsage(job, ctx, agentId, usage) {
  if (!usage) return;
  const u = (ctx.usage[agentId] ??= { input: 0, output: 0, cost: 0 });
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  u.input += input + cacheWrite + cacheRead;
  u.output += output;
  u.cost += (input * PRICE.input + output * PRICE.output + cacheWrite * PRICE.cacheWrite + cacheRead * PRICE.cacheRead) / 1e6;
  const total = Object.values(ctx.usage).reduce((s, x) => s + x.cost, 0);
  ctx.totalCost = total;
  job.emit("usage", { agent: agentId, input: u.input, output: u.output, cost: u.cost, totalCost: total });
}

// ── 한 사람의 업무 루프 (본부장·팀장·팀원 공통) ──────────────
// 부하 직원이 있으면 delegate_task로 일을 나누고, 자료가 있으면 read_material로 읽는다.
// 사람별 대화 기록을 유지해 같은 사람에게 다시 맡기면 이전 작업을 기억한다.
async function runAgent(job, ctx, agentId, firstMessage) {
  const agent = getAgent(agentId);
  const subs = subordinates(agentId);
  const history = (ctx.histories[agentId] ??= []);
  history.push({ role: "user", content: firstMessage });
  job.emit("status", { agent: agentId, state: "thinking" });

  const isTop = agentId === MANAGER_ID;
  const effort = isTop ? MANAGER_EFFORT : subs.length ? LEAD_EFFORT : WORKER_EFFORT;
  const maxTurns = isTop ? MAX_MANAGER_TURNS : subs.length ? MAX_LEAD_TURNS : MAX_WORKER_TURNS;
  let jsonRetries = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const tools = [];
    if (subs.length) tools.push(delegateTool(subs));
    if (ctx.materials.length) tools.push(materialTool(ctx.materials));
    if (agent.search && ctx.webSearch) tools.push(WEB_SEARCH_TOOL);

    let message;
    try {
      message = await streamAgent(job, ctx, agentId, {
        messages: history,
        output_config: { effort },
        ...(tools.length && { tools }),
      });
      jsonRetries = 0;
    } catch (err) {
      if (ctx.cancelled) throw err;
      // 조직 설정에서 웹 검색이 꺼져 있으면 400이 난다 → 검색 없이 다시 시도
      if (agent.search && ctx.webSearch && err instanceof Anthropic.BadRequestError && /web_search/i.test(err.message)) {
        ctx.webSearch = false;
        job.emit("notice", { agent: agentId, message: "웹 검색을 쓸 수 없어 검색 없이 진행합니다." });
        continue;
      }
      // 도구 입력 JSON이 깨진 경우에만 같은 턴을 다시 요청한다. API 오류는 그대로 올린다.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      job.emit("notice", { agent: agentId, message: "지시 내용을 다시 정리하는 중입니다." });
      continue;
    }

    if (message.stop_reason === "refusal") {
      if (isTop) throw new Error("안전 정책상 이 요청은 처리할 수 없습니다.");
      history.pop();
      job.emit("status", { agent: agentId, state: "error" });
      return "(이 업무는 안전 정책상 처리할 수 없었습니다.)";
    }
    history.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "pause_turn") continue; // 서버 도구(웹 검색)가 길어져 일시정지 → 이어서 요청

    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      job.emit("status", { agent: agentId, state: isTop ? "done" : "idle" });
      return textOf(message) || "(결과 없음)";
    }
    if (message.stop_reason === "max_tokens") throw new Error(`${displayName(agent)}의 응답이 너무 길어 중간에 잘렸습니다. 요청을 조금 더 좁혀 주세요.`);

    const delegations = toolUses.filter((t) => t.name === "delegate_task");
    if (delegations.length) job.emit("status", { agent: agentId, state: "waiting" });
    // 독립적인 위임과 자료 읽기는 동시에 실행하고, 결과는 하나의 user 메시지로 모두 돌려준다
    const results = await Promise.all(toolUses.map((tu) => handleTool(job, ctx, agentId, tu)));
    history.push({ role: "user", content: results });
    job.emit("status", { agent: agentId, state: "thinking" });
  }
  throw new Error(`${displayName(agent)}의 작업 턴이 최대치(${maxTurns})를 넘었습니다.`);
}

function displayName(a) {
  return `${a.name} ${a.title}`;
}

async function handleTool(job, ctx, agentId, tu) {
  if (tu.name === "read_material") {
    const { name, part = 1 } = tu.input || {};
    const res = readMaterial(ctx.materials, name, part);
    if (res.error) return { type: "tool_result", tool_use_id: tu.id, content: res.error, is_error: true };
    job.emit("read", { agent: agentId, name, part: res.part, parts: res.parts });
    return { type: "tool_result", tool_use_id: tu.id, content: res.content };
  }
  if (tu.name === "delegate_task") {
    const subs = subordinates(agentId);
    const { agent, instruction } = tu.input || {};
    if (!subs.includes(agent)) return { type: "tool_result", tool_use_id: tu.id, content: `agent는 ${subs.join(", ")} 중 하나여야 합니다.`, is_error: true };
    if (typeof instruction !== "string" || !instruction.trim()) return { type: "tool_result", tool_use_id: tu.id, content: "instruction이 비어 있습니다.", is_error: true };
    job.emit("delegate", { from: agentId, to: agent, callId: tu.id, instruction });
    try {
      const output = await runAgent(job, ctx, agent, instruction);
      job.emit("report", { from: agent, to: agentId, callId: tu.id, text: output });
      return { type: "tool_result", tool_use_id: tu.id, content: output };
    } catch (err) {
      if (ctx.cancelled) throw err;
      job.emit("status", { agent, state: "error" });
      job.emit("notice", { agent, message: `작업 실패: ${err.message}` });
      return { type: "tool_result", tool_use_id: tu.id, content: `오류: ${err.message}`, is_error: true };
    }
  }
  return { type: "tool_result", tool_use_id: tu.id, content: `알 수 없는 도구: ${tu.name}`, is_error: true };
}

export async function runLiveJob(job) {
  const ctx = { histories: {}, usage: {}, webSearch: ENABLE_WEB_SEARCH, cancelled: false, materials: job.materials || [], totalCost: 0 };
  job.cancel = () => (ctx.cancelled = true);

  job.emit("job_started", { id: job.id, task: job.task, mode: "live", model: MODEL, materials: materialIndex(ctx.materials) });
  let first = job.task;
  if (ctx.materials.length) {
    first += `\n\n[첨부 자료 ${ctx.materials.length}건 — read_material 도구로 읽을 수 있습니다]\n` +
      ctx.materials.map((m) => `- ${m.name} (${m.kindLabel}, ${m.parts}부분)\n  미리보기: ${m.preview}`).join("\n");
  }
  const result = await runAgent(job, ctx, MANAGER_ID, first);
  job.emit("job_done", { result, usage: ctx.usage, totalCost: ctx.totalCost });
}

export function describeLiveConfig() {
  return {
    model: MODEL,
    managerEffort: MANAGER_EFFORT,
    leadEffort: LEAD_EFFORT,
    workerEffort: WORKER_EFFORT,
    webSearch: ENABLE_WEB_SEARCH,
    fallback: ENABLE_FALLBACK,
  };
}
