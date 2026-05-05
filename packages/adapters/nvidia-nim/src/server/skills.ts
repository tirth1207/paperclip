import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const MAX_TOOL_NAME_LENGTH = 64;

export type NvidiaNimToolDefinition = {
  entry: {
    key: string;
    runtimeName: string;
    source: string;
    required?: boolean;
    requiredReason?: string | null;
  };
  toolName: string;
  displayName: string;
  description: string;
  markdown: string;
  schema: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: {
        type: "object";
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
    };
  };
};

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6) || "skill";
}

function buildToolName(skillKey: string, runtimeName: string): string {
  const base = normalizeSlug(runtimeName || skillKey.split("/").pop() || skillKey) || "skill";
  const prefix = "skill__";
  const suffix = `_${shortHash(skillKey)}`;
  const maxBaseLength = Math.max(1, MAX_TOOL_NAME_LENGTH - prefix.length - suffix.length);
  return `${prefix}${base.slice(0, maxBaseLength)}${suffix}`;
}

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized;
  return normalized.slice(closing + 5);
}

function readFrontmatterValue(markdown: string, key: string): string | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return null;
  const frontmatter = normalized.slice(4, closing);
  const match = frontmatter.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "mi"));
  if (!match) return null;
  return match[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null;
}

function firstMeaningfulParagraph(markdown: string): string | null {
  const body = stripFrontmatter(markdown)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .find((block) => !block.startsWith("#"));
  return body ? body.replace(/\s+/g, " ").trim() : null;
}

async function readSkillMarkdown(entry: { source: string }): Promise<string> {
  return fs.readFile(path.join(entry.source, "SKILL.md"), "utf8");
}

function toSnapshotEntries(
  availableEntries: Array<{ key: string; runtimeName: string; source: string; required?: boolean; requiredReason?: string | null }>,
  desiredSkills: string[],
): AdapterSkillEntry[] {
  const desiredSet = new Set(desiredSkills);
  return availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: entry.required ? "paperclip_required" : "company_managed",
    originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be injected as an OpenAI-compatible tool during the next NVIDIA NIM run."
      : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));
}

async function buildNvidiaNimSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const entries = toSnapshotEntries(availableEntries, desiredSkills);
  const availableByKey = new Set(availableEntries.map((entry: { key: string }) => entry.key));
  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "nvidia-nim",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listNvidiaNimSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildNvidiaNimSkillSnapshot(ctx.config);
}

export async function syncNvidiaNimSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildNvidiaNimSkillSnapshot(ctx.config);
}

export async function buildNvidiaNimTools(
  config: Record<string, unknown>,
): Promise<NvidiaNimToolDefinition[]> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = new Set(resolvePaperclipDesiredSkillNames(config, availableEntries));
  const selectedEntries = availableEntries.filter((entry: { key: string }) => desiredSkills.has(entry.key));
  const tools: NvidiaNimToolDefinition[] = [];

  for (const entry of selectedEntries) {
    const markdown = await readSkillMarkdown(entry);
    const displayName =
      readFrontmatterValue(markdown, "name") ??
      entry.runtimeName ??
      entry.key.split("/").pop() ??
      entry.key;
    const description =
      readFrontmatterValue(markdown, "description") ??
      firstMeaningfulParagraph(markdown) ??
      `Read and apply the "${displayName}" Paperclip skill instructions.`;
    const toolName = buildToolName(entry.key, entry.runtimeName);
    tools.push({
      entry,
      toolName,
      displayName,
      description,
      markdown,
      schema: {
        type: "function",
        function: {
          name: toolName,
          description: description.slice(0, 1024),
          parameters: {
            type: "object",
            properties: {
              goal: {
                type: "string",
                description: "Optional note describing why this skill is being used in the current step.",
              },
            },
            required: [],
            additionalProperties: false,
          },
        },
      },
    });
  }

  return tools;
}

export function resolveNvidiaNimDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}

export async function executeNvidiaNimSkillTool(
  toolName: string,
  args: unknown,
  tools: NvidiaNimToolDefinition[],
): Promise<{ toolUseId?: string; toolName: string; content: string; isError: boolean }> {
  const tool = tools.find((entry) => entry.toolName === toolName);
  if (!tool) {
    return {
      toolName,
      content: `Unknown Paperclip skill tool "${toolName}".`,
      isError: true,
    };
  }

  const goal =
    typeof args === "object" && args !== null && !Array.isArray(args) && typeof (args as Record<string, unknown>).goal === "string"
      ? (args as Record<string, unknown>).goal as string
      : "";

  const content = [
    `Skill: ${tool.displayName}`,
    `Key: ${tool.entry.key}`,
    `Runtime name: ${tool.entry.runtimeName}`,
    goal.trim().length > 0 ? `Requested goal: ${goal.trim()}` : null,
    "Instructions:",
    tool.markdown.trim(),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n\n");

  return {
    toolName,
    content,
    isError: false,
  };
}
