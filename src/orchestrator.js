import Anthropic from "@anthropic-ai/sdk";
import { MANAGER_ID, SYSTEM_PROMPTS, WORKER_IDS } from "./agents.js";

// ── 설정 (.env로 덮어쓸 수 있음) ──────────────────────────────
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const MANAGER_EFFORT = process.env.MANAGER_EFFORT || "high";
const WORKER_EFFORT = process.env.WORKER_EFFORT || "medium";
const MAX_MANAGER_TURNS = Number(process.env.MAX_MANAGER_TURNS || 8);
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

const DELEGATE_TOOL = {
  name: "delegate_task",
  description:
    "팀원 한 명에게 업무를 맡기고 그 결과를 받는다. 서로 독립적인 업무는 같은 응답에서 여러 번 호출하면 동시에 진행된다. " +
    "팀원은 사용자 요청이나 다른 팀원의 결과를 볼 수 없으므로, instruction에 필요한 배경과 앞선 결과의 핵심을 모두 담아야 한다.",
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: WORKER_IDS,
        description: "researcher=리서처(웹 검색), planner=기획자, writer=작가, reviewer=검토자",
      },
      instruction: {
        type: "string",
        description: "팀원에게 줄 구체적인 업무 지시. 목적, 범위, 결과물 형식, 참고할 앞선 결과를 포함한다.",
      },
    },
    required: ["agent", "instruction"],
  },
};

function validateDelegateInput(input) {
  if (!input || typeof input !== "object") return "입력이 객체가 아닙니다.";
  if (!WORKER_IDS.includes(input.agent)) return `agent는 ${WORKER_IDS.join(", ")} 중 하나여야 합니다.`;
  if (typeof input.instruction !== "string" || !input.instruction.trim()) return "instruction이 비어 있습니다.";
  return null;
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// ── 에이전트 한 번의 호출을 스트리밍하면서 화면용 이벤트를 내보낸다 ──
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
        else if (d.type === "input_json_delta" && event.index in serverToolInput) {
          serverToolInput[event.index] += d.partial_json;
        }
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
  u.cost +=
    (input * PRICE.input + output * PRICE.output + cacheWrite * PRICE.cacheWrite + cacheRead * PRICE.cacheRead) / 1e6;
  const total = Object.values(ctx.usage).reduce((s, x) => s + x.cost, 0);
  job.emit("usage", { agent: agentId, input: u.input, output: u.output, cost: u.cost, totalCost: total });
}

// ── 팀원 실행: 팀원별 대화 기록을 유지해 같은 팀원에게 다시 맡기면 이전 작업을 기억한다 ──
async function runWorker(job, ctx, agentId, instruction, callId) {
  const history = (ctx.histories[agentId] ??= []);
  history.push({ role: "user", content: instruction });
  job.emit("status", { agent: agentId, state: "thinking" });

  let message;
  for (let round = 0; round < 5; round++) {
    const tools = agentId === "researcher" && ctx.webSearch ? [WEB_SEARCH_TOOL] : undefined;
    try {
      message = await streamAgent(job, ctx, agentId, {
        messages: history,
        output_config: { effort: WORKER_EFFORT },
        ...(tools && { tools }),
      });
    } catch (err) {
      // 조직 설정에서 웹 검색이 꺼져 있으면 400이 난다 → 검색 없이 다시 시도
      if (tools && err instanceof Anthropic.BadRequestError) {
        ctx.webSearch = false;
        job.emit("notice", { agent: agentId, message: "웹 검색을 쓸 수 없어 검색 없이 진행합니다." });
        continue;
      }
      throw err;
    }

    if (message.stop_reason === "refusal") {
      history.pop();
      job.emit("status", { agent: agentId, state: "error" });
      return "(이 업무는 안전 정책상 처리할 수 없었습니다.)";
    }
    history.push({ role: "assistant", content: message.content });
    // 서버 도구(웹 검색)가 길어져 일시정지되면 이어서 요청한다
    if (message.stop_reason === "pause_turn") continue;
    break;
  }

  const result = textOf(message) || "(결과 없음)";
  job.emit("report", { from: agentId, to: MANAGER_ID, callId, text: result });
  job.emit("status", { agent: agentId, state: "idle" });
  return result;
}

// ── 팀장 루프: delegate_task 도구로 팀원에게 일을 나눠주고 최종 보고서를 쓴다 ──
export async function runLiveJob(job) {
  const ctx = { histories: {}, usage: {}, webSearch: ENABLE_WEB_SEARCH, cancelled: false };
  job.cancel = () => (ctx.cancelled = true);

  const messages = [{ role: "user", content: job.task }];
  job.emit("job_started", { task: job.task, mode: "live", model: MODEL });
  job.emit("status", { agent: MANAGER_ID, state: "thinking" });

  let jsonRetries = 0;
  for (let turn = 0; turn < MAX_MANAGER_TURNS; turn++) {
    let message;
    try {
      message = await streamAgent(job, ctx, MANAGER_ID, {
        messages,
        tools: [DELEGATE_TOOL],
        output_config: { effort: MANAGER_EFFORT },
      });
      jsonRetries = 0;
    } catch (err) {
      // 도구 입력 JSON이 깨진 경우에만 같은 턴을 다시 요청한다. API 오류는 그대로 올린다.
      if (err instanceof Anthropic.APIError || ctx.cancelled || jsonRetries++ >= 2) throw err;
      job.emit("notice", { agent: MANAGER_ID, message: "지시 내용을 다시 정리하는 중입니다." });
      continue;
    }

    if (message.stop_reason === "refusal") {
      throw new Error("안전 정책상 이 요청은 처리할 수 없습니다.");
    }
    messages.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      job.emit("status", { agent: MANAGER_ID, state: "done" });
      job.emit("job_done", { result: textOf(message), usage: ctx.usage });
      return;
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error("팀장의 응답이 너무 길어 중간에 잘렸습니다. 요청을 조금 더 좁혀 주세요.");
    }

    // 독립적인 위임은 동시에 실행하고, 결과는 하나의 user 메시지로 모두 돌려준다
    job.emit("status", { agent: MANAGER_ID, state: "waiting" });
    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const problem = validateDelegateInput(tu.input);
        if (problem) {
          return { type: "tool_result", tool_use_id: tu.id, content: problem, is_error: true };
        }
        const { agent, instruction } = tu.input;
        job.emit("delegate", { from: MANAGER_ID, to: agent, callId: tu.id, instruction });
        try {
          const output = await runWorker(job, ctx, agent, instruction, tu.id);
          return { type: "tool_result", tool_use_id: tu.id, content: output };
        } catch (err) {
          if (ctx.cancelled) throw err;
          job.emit("status", { agent, state: "error" });
          job.emit("notice", { agent, message: `작업 실패: ${err.message}` });
          return { type: "tool_result", tool_use_id: tu.id, content: `오류: ${err.message}`, is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
    job.emit("status", { agent: MANAGER_ID, state: "thinking" });
  }

  throw new Error(`팀장 작업 턴이 최대치(${MAX_MANAGER_TURNS})를 넘었습니다.`);
}

export function describeLiveConfig() {
  return { model: MODEL, managerEffort: MANAGER_EFFORT, workerEffort: WORKER_EFFORT, webSearch: ENABLE_WEB_SEARCH, fallback: ENABLE_FALLBACK };
}
