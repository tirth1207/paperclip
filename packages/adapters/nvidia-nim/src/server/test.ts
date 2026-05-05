import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_NVIDIA_NIM_BASE_URL } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function resolveBaseUrl(config: Record<string, unknown>, env: Record<string, string>): string {
  const explicit = asString(config.baseUrl, "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return ((env.NVIDIA_NIM_BASE_URL ?? DEFAULT_NVIDIA_NIM_BASE_URL).trim() || DEFAULT_NVIDIA_NIM_BASE_URL).replace(/\/+$/, "");
}

function classifyProbeStatus(status: number): {
  code: string;
  level: AdapterEnvironmentCheck["level"];
  message: string;
  hint?: string | null;
} {
  if (status >= 200 && status < 300) {
    return {
      code: "nvidia_nim_endpoint_reachable",
      level: "info",
      message: "NVIDIA NIM endpoint responded to a connectivity probe.",
      hint: null,
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: "nvidia_nim_endpoint_auth_required",
      level: "info",
      message: `NVIDIA NIM endpoint responded with HTTP ${status}, which confirms the host is reachable and expects authentication.`,
      hint: null,
    };
  }
  if (status === 404 || status === 405) {
    return {
      code: "nvidia_nim_endpoint_root_not_probeable",
      level: "info",
      message: `Endpoint probe returned HTTP ${status}. The NVIDIA host is reachable, but this root path does not serve the probe method.`,
      hint: "This is usually fine for OpenAI-compatible APIs that only expose specific subpaths such as /chat/completions.",
    };
  }
  return {
    code: "nvidia_nim_endpoint_probe_unexpected_status",
    level: "warn",
    message: `Endpoint probe returned HTTP ${status}.`,
    hint: "Verify outbound connectivity from the Paperclip server to the NVIDIA NIM API and confirm the base URL is correct.",
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const env = normalizeEnv(config.env);
  const baseUrl = resolveBaseUrl(config, env);
  const apiKey = asString(config.apiKey, "").trim() || (env.NVIDIA_NIM_API_KEY ?? "").trim();
  const model = asString(config.model, "").trim();

  checks.push({
    code: "nvidia_nim_base_url",
    level: "info",
    message: `Configured endpoint: ${baseUrl}`,
  });

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      checks.push({
        code: "nvidia_nim_base_url_protocol_invalid",
        level: "error",
        message: `Unsupported base URL protocol: ${url.protocol}`,
        hint: "Use an http:// or https:// NVIDIA NIM endpoint.",
      });
    }
  } catch {
    checks.push({
      code: "nvidia_nim_base_url_invalid",
      level: "error",
      message: `Invalid NVIDIA NIM base URL: ${baseUrl}`,
    });
  }

  if (!apiKey) {
      checks.push({
        code: "nvidia_nim_api_key_missing",
        level: "error",
        message: "NVIDIA_NIM_API_KEY is missing.",
        hint: "Set NVIDIA_NIM_API_KEY in the adapter env JSON or the Paperclip server environment.",
      });
  } else {
    checks.push({
      code: "nvidia_nim_api_key_present",
      level: "info",
      message: "Found NVIDIA_NIM_API_KEY for runtime requests.",
    });
  }

  if (!model) {
    checks.push({
      code: "nvidia_nim_model_missing",
      level: "warn",
      message: "No explicit model configured; the adapter will fall back to its default model.",
    });
  } else {
    checks.push({
      code: "nvidia_nim_model_configured",
      level: "info",
      message: `Configured model: ${model}`,
    });
  }

  if (baseUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(baseUrl, {
        method: "HEAD",
        signal: controller.signal,
      });
      const probe = classifyProbeStatus(response.status);
      checks.push(probe);
    } catch (error) {
      checks.push({
        code: "nvidia_nim_endpoint_probe_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Endpoint probe failed",
        hint: "This may be expected in restricted networks; verify connectivity when invoking runs.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
