import {
  asNumber,
  asString,
  parseJson,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

export type NvidiaNimEvent =
  | { type: "message"; text: string; delta: boolean }
  | { type: "tool_call"; call_id: string; tool_name: string; arguments: unknown }
  | { type: "tool_result"; call_id: string; tool_name: string; content: string; is_error: boolean }
  | {
      type: "final_output";
      text: string;
      finish_reason: string | null;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
      };
    };

export type NvidiaNimAccumulatedToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type NvidiaNimAccumulatedResponse = {
  text: string;
  finishReason: string | null;
  toolCalls: NvidiaNimAccumulatedToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
};

type StreamAccumulatorState = {
  text: string;
  finishReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  toolCallsByIndex: Map<number, NvidiaNimAccumulatedToolCall>;
};

export function createNvidiaNimAccumulator(): StreamAccumulatorState {
  return {
    text: "",
    finishReason: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    },
    toolCallsByIndex: new Map(),
  };
}

export function finalizeNvidiaNimAccumulator(state: StreamAccumulatorState): NvidiaNimAccumulatedResponse {
  const toolCalls = [...state.toolCallsByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]);
  return {
    text: state.text,
    finishReason: state.finishReason,
    toolCalls,
    usage: state.usage,
  };
}

export function parseToolArguments(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = parseJson(trimmed);
  return parsed ?? { raw: trimmed };
}

export function buildNvidiaNimLogLine(event: NvidiaNimEvent): string {
  return `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
}

export function parseNvidiaNimFailure(responseBody: string, fallbackStatusText: string): string {
  const parsed = parseJson(responseBody);
  const error = parseObject(parsed?.error);
  const message =
    asString(error.message, "").trim() ||
    asString(parsed?.message, "").trim() ||
    responseBody.trim();
  return message || fallbackStatusText;
}

function upsertToolCall(state: StreamAccumulatorState, rawIndex: unknown): NvidiaNimAccumulatedToolCall {
  const index = typeof rawIndex === "number" && Number.isFinite(rawIndex) ? rawIndex : state.toolCallsByIndex.size;
  const existing = state.toolCallsByIndex.get(index);
  if (existing) return existing;
  const created: NvidiaNimAccumulatedToolCall = {
    id: `tool_call_${index + 1}`,
    type: "function",
    function: {
      name: "",
      arguments: "",
    },
  };
  state.toolCallsByIndex.set(index, created);
  return created;
}

export function applyNvidiaNimChunk(
  state: StreamAccumulatorState,
  chunk: Record<string, unknown>,
): NvidiaNimEvent[] {
  const emitted: NvidiaNimEvent[] = [];
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const usage = parseObject(chunk.usage);
  if (Object.keys(usage).length > 0) {
    state.usage.inputTokens = asNumber(usage.prompt_tokens, state.usage.inputTokens);
    state.usage.outputTokens = asNumber(usage.completion_tokens, state.usage.outputTokens);
    state.usage.cachedInputTokens = asNumber(
      usage.cached_tokens,
      asNumber(usage.prompt_tokens_details && parseObject(usage.prompt_tokens_details).cached_tokens, state.usage.cachedInputTokens),
    );
  }

  for (const rawChoice of choices) {
    const choice = parseObject(rawChoice);
    const delta = parseObject(choice.delta);
    const finishReason = asString(choice.finish_reason, "").trim();
    if (finishReason) state.finishReason = finishReason;

    const contentDelta = asString(delta.content, "");
    if (contentDelta) {
      state.text += contentDelta;
      emitted.push({ type: "message", text: contentDelta, delta: true });
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawToolCall of toolCalls) {
      const toolCall = parseObject(rawToolCall);
      const accumulator = upsertToolCall(state, toolCall.index);
      const nextId = asString(toolCall.id, "").trim();
      if (nextId) accumulator.id = nextId;
      const functionBlock = parseObject(toolCall.function);
      const nextName = asString(functionBlock.name, "");
      if (nextName) accumulator.function.name += nextName;
      const nextArguments = asString(functionBlock.arguments, "");
      if (nextArguments) accumulator.function.arguments += nextArguments;
    }
  }

  return emitted;
}

export function parseNvidiaNimResponseJson(payload: Record<string, unknown>): NvidiaNimAccumulatedResponse {
  const state = createNvidiaNimAccumulator();
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const usage = parseObject(payload.usage);
  state.usage.inputTokens = asNumber(usage.prompt_tokens, 0);
  state.usage.outputTokens = asNumber(usage.completion_tokens, 0);
  state.usage.cachedInputTokens = asNumber(
    usage.cached_tokens,
    asNumber(usage.prompt_tokens_details && parseObject(usage.prompt_tokens_details).cached_tokens, 0),
  );

  for (const rawChoice of choices) {
    const choice = parseObject(rawChoice);
    const message = parseObject(choice.message);
    const content = asString(message.content, "");
    if (content) state.text += content;
    const finishReason = asString(choice.finish_reason, "").trim();
    if (finishReason) state.finishReason = finishReason;

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const [index, rawToolCall] of toolCalls.entries()) {
      const toolCall = parseObject(rawToolCall);
      const accumulator = upsertToolCall(state, index);
      accumulator.id = asString(toolCall.id, accumulator.id);
      const functionBlock = parseObject(toolCall.function);
      accumulator.function.name = asString(functionBlock.name, accumulator.function.name);
      accumulator.function.arguments = asString(functionBlock.arguments, accumulator.function.arguments);
    }
  }

  return finalizeNvidiaNimAccumulator(state);
}

export async function consumeNvidiaNimSse(
  response: Response,
  onChunk: (events: NvidiaNimEvent[]) => Promise<void> | void,
): Promise<NvidiaNimAccumulatedResponse> {
  const state = createNvidiaNimAccumulator();
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body ?? []) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const boundaryIndex = buffer.search(/\r?\n\r?\n/);
      if (boundaryIndex < 0) break;
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + (buffer[boundaryIndex] === "\r" ? 4 : 2));

      const dataLines = rawEvent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) continue;

      const payload = dataLines.join("\n");
      if (payload === "[DONE]") continue;
      const parsed = parseJson(payload);
      if (!parsed) continue;
      const events = applyNvidiaNimChunk(state, parsed);
      if (events.length > 0) await onChunk(events);
    }
  }

  const trailing = decoder.decode();
  if (trailing) buffer += trailing;

  return finalizeNvidiaNimAccumulator(state);
}
