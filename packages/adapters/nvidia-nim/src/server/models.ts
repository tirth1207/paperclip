import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as defaultModels } from "../index.js";

export const NVIDIA_NIM_MODELS: AdapterModel[] = [...defaultModels];

export async function listNvidiaNimModels(): Promise<AdapterModel[]> {
  return [...NVIDIA_NIM_MODELS];
}
