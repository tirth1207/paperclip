import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  joinPromptSections,
  parseJson,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipDesiredSkillNames,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_NVIDIA_NIM_BASE_URL,
  DEFAULT_NVIDIA_NIM_MODEL,
} from "../index.js";
import {
  buildNvidiaNimLogLine,
  consumeNvidiaNimSse,
  parseNvidiaNimFailure,
  parseNvidiaNimResponseJson,
  parseToolArguments,
  type NvidiaNimAccumulatedResponse,
  type NvidiaNimEvent,
} from "./parse.js";
import {
  buildNvidiaNimTools,
  executeNvidiaNimSkillTool,
  type NvidiaNimToolDefinition,
} from "./skills.js";

const DEFAULT_TIMEOUT_SEC = 180;
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

type OpenAiMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; tool_calls?: Array<Record<string, unknown>> }
  | { role: "tool"; tool_call_id: string; content: string; name?: string };

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function resolveBaseUrl(config: Record<string, unknown>, env: Record<string, string>): string {
  const explicit = asString(config.baseUrl, "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const fromEnv = (env.NVIDIA_NIM_BASE_URL ?? "").trim();
  return (fromEnv || DEFAULT_NVIDIA_NIM_BASE_URL).replace(/\/+$/, "");
}

function resolveApiKey(config: Record<string, unknown>, env: Record<string, string>): string {
  const explicit = asString(config.apiKey, "").trim();
  if (explicit) return explicit;
  const fromEnv = (env.NVIDIA_NIM_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  throw new Error("NVIDIA_NIM_API_KEY is required.");
}

function resolveToolChoice(
  config: Record<string, unknown>,
): "auto" | "none" | "required" | Record<string, unknown> | undefined {
  const raw = config.toolChoice;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed === "auto" || trimmed === "none" || trimmed === "required") {
      return trimmed as "auto" | "none" | "required";
    }
    const parsed = parseJson(trimmed);
    return parsed ?? { type: "function", function: { name: trimmed } };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return undefined;
}

function toInvocationEnvForLogs(env: Record<string, string>): Record<string, string> {
  const logged = { ...env };
  if (logged.NVIDIA_NIM_API_KEY) logged.NVIDIA_NIM_API_KEY = "***REDACTED***";
  return logged;
}

async function readInstructionsPrefix(instructionsFilePath: string, onLog: AdapterExecutionContext["onLog"]): Promise<{
  prefix: string;
  chars: number;
}> {
  if (!instructionsFilePath) return { prefix: "", chars: 0 };
  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const prefix =
      `${contents}\n\n` +
      `The above agent instructions were loaded from ${instructionsFilePath}. ` +
      `Resolve any relative file references from ${path.dirname(instructionsFilePath)}/.\n`;
    return { prefix, chars: prefix.length };
  } catch (error) {
    await onLog(
      "stdout",
      `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { prefix: "", chars: 0 };
  }
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking the provided context.",
  ].join("\n");
}

function classifyNvidiaNimError(message: string, status: number): Pick<
  AdapterExecutionResult,
  "errorCode" | "errorFamily"
> {
  const normalized = message.trim().toLowerCase();
  if (status === 401 || /invalid api key|unauthorized|authentication/i.test(message)) {
    return { errorCode: "nvidia_nim_invalid_api_key", errorFamily: null };
  }
  if (status === 429 || /rate limit|too many requests|quota/i.test(normalized)) {
    return { errorCode: "nvidia_nim_rate_limited", errorFamily: "transient_upstream" };
  }
  if (status >= 500) {
    return { errorCode: "nvidia_nim_upstream_error", errorFamily: "transient_upstream" };
  }
  if (/malformed|invalid json|unexpected/i.test(normalized)) {
    return { errorCode: "nvidia_nim_malformed_response", errorFamily: null };
  }
  return { errorCode: "nvidia_nim_request_failed", errorFamily: null };
}

async function emitEvents(
  onLog: AdapterExecutionContext["onLog"],
  events: NvidiaNimEvent[],
): Promise<void> {
  for (const event of events) {
    await onLog("stdout", buildNvidiaNimLogLine(event));
  }
}

function buildInitialMessages(input: {
  systemPrompt: string;
  userPrompt: string;
}): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  if (input.systemPrompt.trim()) {
    messages.push({ role: "system", content: input.systemPrompt.trim() });
  }
  messages.push({ role: "user", content: input.userPrompt.trim() });
  return messages;
}

async function runNvidiaNimRequest(input: {
  ctx: AdapterExecutionContext;
  url: string;
  apiKey: string;
  timeoutSec: number;
  model: string;
  messages: OpenAiMessage[];
  tools: NvidiaNimToolDefinition[];
  toolChoice: "auto" | "none" | "required" | Record<string, unknown> | undefined;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
}): Promise<NvidiaNimAccumulatedResponse> {
  const { ctx } = input;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, input.timeoutSec) * 1000);

  const payload: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: true,
  };
  if (input.tools.length > 0) payload.tools = input.tools.map((tool) => tool.schema);
  if (input.toolChoice !== undefined) payload.tool_choice = input.toolChoice;
  if (typeof input.temperature === "number") payload.temperature = input.temperature;
  if (typeof input.topP === "number") payload.top_p = input.topP;
  if (typeof input.maxTokens === "number") payload.max_tokens = input.maxTokens;

  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw Object.assign(
        new Error(parseNvidiaNimFailure(bodyText, `NVIDIA NIM request failed with HTTP ${response.status}.`)),
        { status: response.status, responseBody: bodyText },
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return await consumeNvidiaNimSse(response, async (events) => emitEvents(ctx.onLog, events));
    }

    const bodyText = await response.text();
    const parsed = parseJson(bodyText);
    if (!parsed) {
      throw Object.assign(new Error("NVIDIA NIM returned a malformed JSON response."), {
        status: response.status,
        responseBody: bodyText,
      });
    }
    const accumulated = parseNvidiaNimResponseJson(parsed);
    if (accumulated.text) {
      await emitEvents(ctx.onLog, [{ type: "message", text: accumulated.text, delta: false }]);
    }
    return accumulated;
  } finally {
    clearTimeout(timeout);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;
  const envConfig = normalizeEnv(config.env);
  const paperclipEnv = buildPaperclipEnv(agent);
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  const combinedEnv: Record<string, string> = {
    ...paperclipEnv,
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    ...envConfig,
  };
  combinedEnv.PAPERCLIP_RUN_ID = runId;
  if (wakeTaskId) combinedEnv.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) combinedEnv.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) combinedEnv.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) combinedEnv.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) combinedEnv.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) combinedEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) combinedEnv.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (!hasNonEmptyEnvValue(combinedEnv, "PAPERCLIP_API_KEY") && authToken) {
    combinedEnv.PAPERCLIP_API_KEY = authToken;
  }

  const model = asString(config.model, DEFAULT_NVIDIA_NIM_MODEL).trim() || DEFAULT_NVIDIA_NIM_MODEL;
  const baseUrl = resolveBaseUrl(config, combinedEnv);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const maxToolRounds = Math.max(1, Math.floor(asNumber(config.maxToolRounds, DEFAULT_MAX_TOOL_ROUNDS)));
  const toolChoice = resolveToolChoice(config);
  const temperature = typeof config.temperature === "number" ? config.temperature : null;
  const topP = typeof config.topP === "number" ? config.topP : null;
  const maxTokens = typeof config.maxTokens === "number" ? Math.floor(config.maxTokens) : null;
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const apiKey = resolveApiKey(config, combinedEnv);
  const tools = await buildNvidiaNimTools(config);
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(
    config,
    await readPaperclipRuntimeSkillEntries(config, __moduleDir),
  );

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    bootstrapPromptTemplate.trim().length > 0 ? renderTemplate(bootstrapPromptTemplate, templateData).trim() : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const { prefix: instructionsPrefix, chars: instructionsChars } = await readInstructionsPrefix(instructionsFilePath, onLog);
  const paperclipEnvNote = renderPaperclipEnvNote(combinedEnv);
  const userPrompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    paperclipEnvNote,
    renderedPrompt,
  ]);
  const systemPrompt = instructionsPrefix;

  if (onMeta) {
    await onMeta({
      adapterType: "nvidia-nim",
      command: "fetch",
      commandNotes: [
        `POST ${baseUrl}/chat/completions`,
        "Uses NVIDIA's OpenAI-compatible chat completions API.",
        tools.length > 0
          ? `Injected ${tools.length} Paperclip skill tool(s): ${desiredSkillNames.join(", ")}`
          : "No Paperclip skill tools were injected for this run.",
      ],
      env: toInvocationEnvForLogs({
        NVIDIA_NIM_API_KEY: apiKey,
        NVIDIA_NIM_BASE_URL: baseUrl,
        ...envConfig,
      }),
      prompt: joinPromptSections([systemPrompt, userPrompt]),
      promptMetrics: {
        promptChars: userPrompt.length + systemPrompt.length,
        instructionsChars,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        runtimeNoteChars: paperclipEnvNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  const url = `${baseUrl}/chat/completions`;
  const messages = buildInitialMessages({ systemPrompt, userPrompt });
  const rawTranscripts: Array<Record<string, unknown>> = [];
  let finalSummary = "";
  let finalUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  let exitCode = 0;
  let errorMessage: string | null = null;
  let errorCode: string | null = null;
  let errorFamily: AdapterExecutionResult["errorFamily"] = null;

  try {
    for (let toolRound = 0; toolRound < maxToolRounds; toolRound += 1) {
      const response = await runNvidiaNimRequest({
        ctx,
        url,
        apiKey,
        timeoutSec,
        model,
        messages,
        tools,
        toolChoice,
        temperature,
        topP,
        maxTokens,
      });

      rawTranscripts.push({
        round: toolRound + 1,
        assistant: {
          text: response.text,
          finishReason: response.finishReason,
          toolCalls: response.toolCalls,
        },
      });
      finalUsage = response.usage;

      if (response.toolCalls.length === 0) {
        finalSummary = response.text.trim();
        await emitEvents(onLog, [{
          type: "final_output",
          text: finalSummary,
          finish_reason: response.finishReason,
          usage: response.usage,
        }]);
        break;
      }

      messages.push({
        role: "assistant",
        content: response.text || null,
        tool_calls: response.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: toolCall.type,
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        })),
      });

      for (const toolCall of response.toolCalls) {
        const parsedArgs = parseToolArguments(toolCall.function.arguments);
        await emitEvents(onLog, [{
          type: "tool_call",
          call_id: toolCall.id,
          tool_name: toolCall.function.name,
          arguments: parsedArgs,
        }]);
        const toolResult = await executeNvidiaNimSkillTool(toolCall.function.name, parsedArgs, tools);
        await emitEvents(onLog, [{
          type: "tool_result",
          call_id: toolCall.id,
          tool_name: toolCall.function.name,
          content: toolResult.content,
          is_error: toolResult.isError,
        }]);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: toolResult.content,
        });
      }

      if (toolRound === maxToolRounds - 1) {
        finalSummary = response.text.trim();
        errorMessage = `NVIDIA NIM exceeded the maximum tool-call rounds (${maxToolRounds}).`;
        errorCode = "nvidia_nim_tool_round_limit";
        exitCode = 1;
      }
    }
  } catch (error) {
    exitCode = 1;
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        exitCode,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        provider: "nvidia",
        biller: inferOpenAiCompatibleBiller(combinedEnv, "nvidia") ?? "nvidia",
        model,
        billingType: "api",
        resultJson: {
          rounds: rawTranscripts,
        },
        summary: finalSummary || null,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    const status =
      typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number"
        ? ((error as { status: number }).status)
        : 0;
    const classified = classifyNvidiaNimError(message, status);
    errorMessage = message;
    errorCode = classified.errorCode ?? null;
    errorFamily = classified.errorFamily ?? null;
  }

  return {
    exitCode,
    signal: null,
    timedOut: false,
    errorMessage,
    errorCode,
    errorFamily,
    usage: finalUsage,
    provider: "nvidia",
    biller: inferOpenAiCompatibleBiller(combinedEnv, "nvidia") ?? "nvidia",
    model,
    billingType: "api",
    costUsd: null,
    resultJson: {
      rounds: rawTranscripts,
      baseUrl,
    },
    summary: finalSummary || firstNonEmptyLine(errorMessage ?? "") || null,
    clearSession: false,
  };
}
