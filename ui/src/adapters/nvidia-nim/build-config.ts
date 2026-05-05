import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildNvidiaNimConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.model?.trim()) ac.model = v.model.trim();
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;

  if (v.adapterSchemaValues) {
    Object.assign(ac, v.adapterSchemaValues);
  }

  return ac;
}
