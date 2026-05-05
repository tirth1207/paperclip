import type { UIAdapterModule } from "../types";
import { parseNvidiaNimStdoutLine } from "./parse-stdout";
import { NvidiaNimConfigFields } from "./config-fields";
import { buildNvidiaNimConfig } from "./build-config";

export const nvidiaNimUIAdapter: UIAdapterModule = {
  type: "nvidia-nim",
  label: "NVIDIA NIM",
  parseStdoutLine: parseNvidiaNimStdoutLine,
  ConfigFields: NvidiaNimConfigFields,
  buildAdapterConfig: buildNvidiaNimConfig,
};
