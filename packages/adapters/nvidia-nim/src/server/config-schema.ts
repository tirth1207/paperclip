import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_NVIDIA_NIM_BASE_URL,
  DEFAULT_NVIDIA_NIM_MODEL,
  models,
} from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "select",
        default: DEFAULT_NVIDIA_NIM_MODEL,
        required: true,
        options: models.map((model) => ({ value: model.id, label: model.label })),
        hint: "OpenAI-compatible NIM model id sent to POST /v1/chat/completions.",
      },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        default: DEFAULT_NVIDIA_NIM_BASE_URL,
        hint: "Optional override for the NVIDIA NIM OpenAI-compatible API base URL.",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file",
        type: "text",
        hint: "Optional absolute path to markdown instructions injected as the system message.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
      },
      {
        key: "bootstrapPromptTemplate",
        label: "Bootstrap prompt template",
        type: "textarea",
      },
      {
        key: "toolChoice",
        label: "Tool choice JSON",
        type: "textarea",
        hint: "Optional OpenAI-compatible tool_choice value. Leave empty for automatic tool use.",
      },
      {
        key: "maxTokens",
        label: "Max tokens",
        type: "number",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
      },
      {
        key: "topP",
        label: "Top P",
        type: "number",
      },
      {
        key: "maxToolRounds",
        label: "Max tool rounds",
        type: "number",
        default: 8,
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: 180,
      },
      {
        key: "env",
        label: "Environment JSON",
        type: "textarea",
        hint: "Set NVIDIA_NIM_API_KEY here or in the Paperclip host environment. NVIDIA_NIM_BASE_URL is optional.",
      },
    ],
  };
}
