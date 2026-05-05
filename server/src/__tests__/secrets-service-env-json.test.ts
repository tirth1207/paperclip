import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { secretService } from "../services/secrets.ts";

describe("secretService env parsing", () => {
  it("resolves legacy stringified adapterConfig.env JSON for runtime execution", async () => {
    const service = secretService({} as Db);

    const result = await service.resolveAdapterConfigForRuntime("company-1", {
      env: JSON.stringify({
        NVIDIA_NIM_API_KEY: "nvapi-test",
        NVIDIA_NIM_BASE_URL: "https://integrate.api.nvidia.com/v1",
      }),
    });

    expect(result.config).toEqual({
      env: {
        NVIDIA_NIM_API_KEY: "nvapi-test",
        NVIDIA_NIM_BASE_URL: "https://integrate.api.nvidia.com/v1",
      },
    });
    expect(Array.from(result.secretKeys)).toEqual([]);
  });
});
