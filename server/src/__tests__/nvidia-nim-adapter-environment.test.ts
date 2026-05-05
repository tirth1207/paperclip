import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "@paperclipai/adapter-nvidia-nim/server";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("nvidia-nim environment diagnostics", () => {
  it("reports a missing API key when neither config.apiKey nor env.NVIDIA_NIM_API_KEY is set", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "nvidia-nim",
      config: {
        model: "moonshotai/kimi-k2-instruct",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      },
    });

    expect(result.status).toBe("fail");
    expect(
      result.checks.some(
        (check) => check.code === "nvidia_nim_api_key_missing" && check.level === "error",
      ),
    ).toBe(true);
    expect(
      result.checks.some((check) => check.code === "nvidia_nim_api_key_present"),
    ).toBe(false);
  });
});
