import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "nvidia-nim";
export const label = "NVIDIA NIM";

export const DEFAULT_NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_NVIDIA_NIM_MODEL = "meta/llama-3.1-70b-instruct";

export const models = [
  { id: DEFAULT_NVIDIA_NIM_MODEL, label: "Llama 3.1 70B Instruct" },
  { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct" },
  { id: "mistralai/mistral-small-3.2-24b-instruct", label: "Mistral Small 3.2 24B Instruct" },
  { id: "mistralai/mixtral-8x22b-instruct-v0.1", label: "Mixtral 8x22B Instruct" },
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
  { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "moonshotai/kimi-k2-thinking", label: "Kimi K2 Thinking" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use a smaller Mistral-family NIM model for lower-cost background runs.",
    adapterConfig: {
      model: "mistralai/mistral-small-3.2-24b-instruct",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# nvidia-nim agent configuration

Adapter: nvidia-nim

Use when:
- You want Paperclip to run an agent directly against the NVIDIA NIM hosted API
- You want OpenAI-compatible chat completions with streaming and tool calls
- You want Paperclip runtime skills exposed as callable tools inside one HTTP run

Don't use when:
- You need local CLI session resume semantics like Claude Code, Codex, or Gemini CLI
- You need a generic arbitrary webhook adapter instead of a built-in NVIDIA integration

Core fields:
- model (string, optional): NIM model id. Defaults to ${DEFAULT_NVIDIA_NIM_MODEL}
- baseUrl (string, optional): override base URL. Defaults to ${DEFAULT_NVIDIA_NIM_BASE_URL}
- instructionsFilePath (string, optional): absolute path to markdown instructions prepended as a system message
- promptTemplate (string, optional): Paperclip heartbeat prompt template
- bootstrapPromptTemplate (string, optional): extra prompt content added only on fresh runs
- toolChoice (string | object, optional): forwarded as OpenAI-compatible tool_choice
- maxTokens (number, optional): forwarded as max_tokens
- temperature (number, optional): forwarded as temperature
- topP (number, optional): forwarded as top_p
- maxToolRounds (number, optional): max Paperclip skill-call loops in one run. Defaults to 8
- env (object, optional): environment overrides. Set NVIDIA_NIM_API_KEY here or in the host environment

Operational fields:
- timeoutSec (number, optional): request timeout in seconds

Required environment:
- NVIDIA_NIM_API_KEY

Optional environment:
- NVIDIA_NIM_BASE_URL

Notes:
- NVIDIA documents this endpoint as OpenAI-compatible and streams data-only SSE frames from POST /v1/chat/completions.
- This adapter is stateless across heartbeats; it keeps tool-call context within a single run but does not persist a resumable chat session id between runs.
`;
