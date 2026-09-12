/**
 * Slim projection of session entries for the /tree picker.
 *
 * Built-in /tree keeps every SessionEntry (full message payloads, tool
 * arguments, images) on the tree nodes it walks, filters, and searches.
 * This module copies only the fields the picker paints: ids, topology,
 * a capped preview, and a precomputed search haystack.
 */

export const PREVIEW_MAX = 200;
export const TOOL_ARGS_SNIPPET_MAX = 40;

export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export const FILTER_MODES: FilterMode[] = [
  "default",
  "no-tools",
  "user-only",
  "labeled-only",
  "all",
];

export type EntryKind =
  | "user"
  | "assistant"
  | "toolResult"
  | "bashExecution"
  | "otherMessage"
  | "custom_message"
  | "compaction"
  | "branch_summary"
  | "model_change"
  | "thinking_level_change"
  | "custom"
  | "label"
  | "session_info"
  | "unknown";

export interface ToolCallMeta {
  name: string;
  path?: string;
  file_path?: string;
  command?: string;
  pattern?: string;
  offset?: unknown;
  limit?: unknown;
  /** Shallow, capped JSON snippet for unknown tools. Never a full stringify. */
  argsSnippet?: string;
}

export interface SlimEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  kind: EntryKind;
  role?: string;
  label?: string;
  labelTimestamp?: string;
  preview: string;
  searchText: string;
  hasText: boolean;
  isErrorOrAborted: boolean;
  isSettings: boolean;
  toolCallId?: string;
  toolName?: string;
  toolDisplay?: string;
  customType?: string;
  modelId?: string;
  thinkingLevel?: string;
  tokensBefore?: number;
  sessionName?: string;
  errorPreview?: string;
  bashCommand?: string;
}

export interface SlimTreeNode {
  entry: SlimEntry;
  children: SlimTreeNode[];
}

export interface RawMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  command?: string;
}

export interface RawEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: RawMessage;
  customType?: string;
  content?: unknown;
  summary?: string;
  tokensBefore?: number;
  modelId?: string;
  thinkingLevel?: string;
  name?: string;
  label?: string;
  targetId?: string;
}

const SETTINGS_TYPES = new Set([
  "label",
  "custom",
  "model_change",
  "thinking_level_change",
  "session_info",
]);

const TOOL_META_STRING_KEYS = ["path", "file_path", "command", "pattern"] as const;

export function hasNonWhitespace(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) return true;
  }
  return false;
}

export function extractPreview(content: unknown, max = PREVIEW_MAX): string {
  if (typeof content === "string") return content.slice(0, max);
  if (!Array.isArray(content)) return "";
  let result = "";
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      result += (block as { text: string }).text;
      if (result.length >= max) return result.slice(0, max);
    }
  }
  return result;
}

export function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return hasNonWhitespace(content);
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string" &&
      hasNonWhitespace((block as { text: string }).text)
    ) {
      return true;
    }
  }
  return false;
}

export function normalizePreview(text: string): string {
  return text.replace(/[\n\t]/g, " ").trim();
}

export function summarizeToolArgs(args: unknown, max = TOOL_ARGS_SNIPPET_MAX): string {
  if (args == null) return "";
  if (typeof args !== "object") {
    const s = String(args);
    return s.length > max ? s.slice(0, max) + "..." : s;
  }
  const obj = args as Record<string, unknown>;
  const shallow: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string") {
      shallow[key] = v.length > max ? v.slice(0, max) : v;
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      shallow[key] = v;
    } else {
      shallow[key] = "...";
    }
    try {
      if (JSON.stringify(shallow).length >= max) break;
    } catch {
      break;
    }
  }
  let s: string;
  try {
    s = JSON.stringify(shallow);
  } catch {
    return "";
  }
  return s.length > max ? s.slice(0, max) + "..." : s;
}

export function pickToolMeta(name: string, args: unknown): ToolCallMeta {
  const meta: ToolCallMeta = { name };
  if (args == null) return meta;
  if (typeof args !== "object") {
    meta.argsSnippet = summarizeToolArgs(args);
    return meta;
  }
  const a = args as Record<string, unknown>;
  for (const key of TOOL_META_STRING_KEYS) {
    if (typeof a[key] === "string") meta[key] = a[key];
  }
  if (a.offset !== undefined) meta.offset = a.offset;
  if (a.limit !== undefined) meta.limit = a.limit;
  meta.argsSnippet = summarizeToolArgs(a);
  return meta;
}

function shortenPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

export function formatToolCall(meta: ToolCallMeta): string {
  const name = meta.name;
  switch (name) {
    case "read": {
      const path = shortenPath(String(meta.path || meta.file_path || ""));
      const offset = meta.offset;
      const limit = meta.limit;
      let display = path;
      if (offset !== undefined || limit !== undefined) {
        const start = typeof offset === "number" ? offset : 1;
        const end = typeof limit === "number" ? start + limit - 1 : "";
        display += ":" + String(start) + (end ? "-" + String(end) : "");
      }
      return "[read: " + display + "]";
    }
    case "write":
      return "[write: " + shortenPath(String(meta.path || meta.file_path || "")) + "]";
    case "edit":
      return "[edit: " + shortenPath(String(meta.path || meta.file_path || "")) + "]";
    case "bash": {
      const rawCmd = String(meta.command || "");
      const cmd = rawCmd.replace(/[\n\t]/g, " ").trim().slice(0, 50);
      return "[bash: " + cmd + (rawCmd.length > 50 ? "..." : "") + "]";
    }
    case "grep":
      return "[grep: /" + String(meta.pattern || "") + "/ in " + shortenPath(String(meta.path || ".")) + "]";
    case "find":
      return "[find: " + String(meta.pattern || "") + " in " + shortenPath(String(meta.path || ".")) + "]";
    case "ls":
      return "[ls: " + shortenPath(String(meta.path || ".")) + "]";
    default: {
      if (meta.argsSnippet) return "[" + name + ": " + meta.argsSnippet + "]";
      return "[" + name + "]";
    }
  }
}

function collectToolCalls(entries: RawEntry[]): Map<string, ToolCallMeta> {
  const map = new Map<string, ToolCallMeta>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        typeof block !== "object" ||
        block === null ||
        !("type" in block) ||
        (block as { type: unknown }).type !== "toolCall"
      ) {
        continue;
      }
      const tc = block as { id?: unknown; name?: unknown; arguments?: unknown };
      if (typeof tc.id !== "string" || typeof tc.name !== "string") continue;
      map.set(tc.id, pickToolMeta(tc.name, tc.arguments));
    }
  }
  return map;
}

function collectLabels(entries: RawEntry[]): Map<string, { label: string; timestamp: string }> {
  const labels = new Map<string, { label: string; timestamp: string }>();
  for (const entry of entries) {
    if (entry.type !== "label" || typeof entry.targetId !== "string") continue;
    if (typeof entry.label === "string" && entry.label.length > 0) {
      labels.set(entry.targetId, { label: entry.label, timestamp: entry.timestamp });
    } else {
      labels.delete(entry.targetId);
    }
  }
  return labels;
}

function kindFromEntry(entry: RawEntry): EntryKind {
  switch (entry.type) {
    case "message": {
      const role = entry.message?.role;
      if (role === "user") return "user";
      if (role === "assistant") return "assistant";
      if (role === "toolResult") return "toolResult";
      if (role === "bashExecution") return "bashExecution";
      return "otherMessage";
    }
    case "custom_message":
    case "compaction":
    case "branch_summary":
    case "model_change":
    case "thinking_level_change":
    case "custom":
    case "label":
    case "session_info":
      return entry.type;
    default:
      return "unknown";
  }
}

function isErrorOrAborted(message: RawMessage | undefined): boolean {
  if (!message) return false;
  const stop = message.stopReason;
  if (stop && stop !== "stop" && stop !== "toolUse") return true;
  return typeof message.errorMessage === "string" && hasNonWhitespace(message.errorMessage);
}

function buildSearchText(parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ").toLowerCase();
}

export function projectEntry(
  entry: RawEntry,
  labels: Map<string, { label: string; timestamp: string }>,
  toolCalls: Map<string, ToolCallMeta>,
): SlimEntry {
  const kind = kindFromEntry(entry);
  const labeled = labels.get(entry.id);
  const slim: SlimEntry = {
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    kind,
    preview: "",
    searchText: "",
    hasText: false,
    isErrorOrAborted: false,
    isSettings: SETTINGS_TYPES.has(entry.type),
    label: labeled?.label,
    labelTimestamp: labeled?.timestamp,
  };

  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      const role = msg?.role ?? "unknown";
      slim.role = role;
      slim.hasText = hasTextContent(msg?.content);
      slim.isErrorOrAborted = isErrorOrAborted(msg);
      slim.preview = normalizePreview(extractPreview(msg?.content));
      if (role === "assistant" && !slim.preview && typeof msg?.errorMessage === "string") {
        slim.errorPreview = normalizePreview(extractPreview(msg.errorMessage, 80));
      }
      if (role === "toolResult") {
        slim.toolCallId = msg?.toolCallId;
        slim.toolName = msg?.toolName;
        const meta = msg?.toolCallId ? toolCalls.get(msg.toolCallId) : undefined;
        slim.toolDisplay = meta ? formatToolCall(meta) : "[" + (msg?.toolName ?? "tool") + "]";
      }
      if (role === "bashExecution") {
        slim.bashCommand = typeof msg?.command === "string" ? msg.command : "";
        slim.preview = normalizePreview(extractPreview(slim.bashCommand));
      }
      slim.searchText = buildSearchText([
        slim.label,
        role,
        slim.preview,
        slim.toolDisplay,
        slim.bashCommand,
        slim.errorPreview,
      ]);
      break;
    }
    case "custom_message": {
      slim.customType = entry.customType;
      slim.hasText = hasTextContent(entry.content);
      slim.preview = normalizePreview(extractPreview(entry.content));
      slim.searchText = buildSearchText([slim.label, entry.customType, slim.preview]);
      break;
    }
    case "compaction": {
      slim.tokensBefore = entry.tokensBefore;
      slim.preview = "compaction";
      slim.searchText = buildSearchText([slim.label, "compaction"]);
      break;
    }
    case "branch_summary": {
      slim.preview = normalizePreview(extractPreview(entry.summary));
      slim.searchText = buildSearchText([slim.label, "branch summary", slim.preview]);
      break;
    }
    case "session_info": {
      slim.sessionName = entry.name;
      slim.searchText = buildSearchText([slim.label, "title", entry.name]);
      break;
    }
    case "model_change": {
      slim.modelId = entry.modelId;
      slim.searchText = buildSearchText([slim.label, "model", entry.modelId]);
      break;
    }
    case "thinking_level_change": {
      slim.thinkingLevel = entry.thinkingLevel;
      slim.searchText = buildSearchText([slim.label, "thinking", entry.thinkingLevel]);
      break;
    }
    case "custom": {
      slim.customType = entry.customType;
      slim.searchText = buildSearchText([slim.label, "custom", entry.customType]);
      break;
    }
    case "label": {
      slim.searchText = buildSearchText([slim.label, "label", entry.label ?? ""]);
      break;
    }
    default:
      slim.searchText = buildSearchText([slim.label, entry.type]);
  }

  return slim;
}

export function buildSlimTree(entries: RawEntry[]): SlimTreeNode[] {
  const labels = collectLabels(entries);
  const toolCalls = collectToolCalls(entries);
  const nodeMap = new Map<string, SlimTreeNode>();
  const roots: SlimTreeNode[] = [];

  for (const entry of entries) {
    nodeMap.set(entry.id, {
      entry: projectEntry(entry, labels, toolCalls),
      children: [],
    });
  }

  for (const entry of entries) {
    const node = nodeMap.get(entry.id);
    if (!node) continue;
    if (entry.parentId === null || entry.parentId === entry.id) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort((a, b) => {
      if (a.entry.timestamp < b.entry.timestamp) return -1;
      if (a.entry.timestamp > b.entry.timestamp) return 1;
      return 0;
    });
    stack.push(...node.children);
  }

  return roots;
}

export function extractCopyText(entry: RawEntry): string | undefined {
  let text: string | undefined;
  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      if (msg?.role === "bashExecution") {
        text = msg.command;
      } else if (msg && "content" in msg) {
        text = extractFullContent(msg.content);
        if (!text && msg.role === "assistant") text = msg.errorMessage;
      }
      break;
    }
    case "custom_message":
      text = extractFullContent(entry.content);
      break;
    case "compaction":
    case "branch_summary":
      text = entry.summary;
      break;
  }
  return text?.trim() ? text : undefined;
}

function extractFullContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let result = "";
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      result += (block as { text: string }).text;
    }
  }
  return result;
}
