import { describe, it, expect } from "vitest";
import {
  PREVIEW_MAX,
  buildSlimTree,
  extractCopyText,
  extractPreview,
  formatToolCall,
  hasNonWhitespace,
  hasTextContent,
  pickToolMeta,
  type RawEntry,
} from "../src/project.js";

function entry(partial: Partial<RawEntry> & Pick<RawEntry, "id" | "type">): RawEntry {
  return {
    parentId: partial.parentId ?? null,
    timestamp: partial.timestamp ?? "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("extractPreview", () => {
  it("caps strings without reading past max", () => {
    const huge = "x".repeat(50_000);
    const preview = extractPreview(huge, 200);
    expect(preview).toHaveLength(200);
  });

  it("stops concatenating text blocks once max is reached", () => {
    const content = [
      { type: "text", text: "a".repeat(150) },
      { type: "text", text: "b".repeat(150) },
      { type: "text", text: "c".repeat(10_000) },
    ];
    const preview = extractPreview(content, 200);
    expect(preview).toHaveLength(200);
    expect(preview.startsWith("a")).toBe(true);
    expect(preview.includes("c")).toBe(false);
  });

  it("ignores non-text blocks", () => {
    expect(extractPreview([{ type: "image", data: "xxxx" }, { type: "text", text: "hi" }])).toBe("hi");
  });
});

describe("hasTextContent / hasNonWhitespace", () => {
  it("does not treat whitespace-only as text", () => {
    expect(hasNonWhitespace("   \n\t")).toBe(false);
    expect(hasTextContent("   ")).toBe(false);
    expect(hasTextContent([{ type: "text", text: "  " }])).toBe(false);
  });

  it("returns true on first non-ws char of a huge string", () => {
    expect(hasNonWhitespace("hello" + " ".repeat(1_000_000))).toBe(true);
  });
});

describe("formatToolCall", () => {
  it("formats known tools from picked meta only", () => {
    expect(formatToolCall({ name: "read", path: "/tmp/a.ts", offset: 10, limit: 5 })).toBe(
      "[read: /tmp/a.ts:10-14]",
    );
    expect(formatToolCall({ name: "write", path: "/tmp/a.ts" })).toBe("[write: /tmp/a.ts]");
    expect(formatToolCall({ name: "bash", command: "echo hi" })).toBe("[bash: echo hi]");
  });

  it("does not stringify unknown tool argument blobs", () => {
    const meta = pickToolMeta("my_tool", { payload: "x".repeat(100_000), path: "/tmp/x" });
    expect("payload" in meta).toBe(false);
    expect(formatToolCall(meta)).toBe("[my_tool: /tmp/x]");
  });
});

describe("buildSlimTree", () => {
  it("builds parent/child topology and resolves labels", () => {
    const entries: RawEntry[] = [
      entry({
        id: "u1",
        type: "message",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      }),
      entry({
        id: "a1",
        type: "message",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      }),
      entry({
        id: "lbl",
        type: "label",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:02.000Z",
        targetId: "u1",
        label: "start",
      }),
    ];
    const roots = buildSlimTree(entries);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.entry.kind).toBe("user");
    expect(roots[0]!.entry.label).toBe("start");
    expect(roots[0]!.children[0]!.entry.kind).toBe("assistant");
    expect(roots[0]!.entry.searchText).toContain("hello");
    expect(roots[0]!.entry.searchText).toContain("start");
  });

  it("treats orphans as roots", () => {
    const entries: RawEntry[] = [
      entry({
        id: "orphan",
        type: "message",
        parentId: "missing",
        message: { role: "user", content: "x" },
      }),
    ];
    const roots = buildSlimTree(entries);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.entry.id).toBe("orphan");
  });

  it("caps previews and does not retain huge tool arguments", () => {
    const blob = "Z".repeat(200_000);
    const entries: RawEntry[] = [
      entry({
        id: "u1",
        type: "message",
        parentId: null,
        message: { role: "user", content: blob },
      }),
      entry({
        id: "a1",
        type: "message",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc1", name: "write", arguments: { path: "/tmp/x", content: blob } },
          ],
        },
      }),
      entry({
        id: "tr1",
        type: "message",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "toolResult", toolCallId: "tc1", toolName: "write", content: blob },
      }),
    ];
    const roots = buildSlimTree(entries);
    expect(roots[0]!.entry.preview).toHaveLength(PREVIEW_MAX);
    const tool = roots[0]!.children[0]!.children[0]!.entry;
    expect(tool.kind).toBe("toolResult");
    expect(tool.toolDisplay).toBe("[write: /tmp/x]");
    expect(tool.preview.length).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(JSON.stringify(tool).includes(blob)).toBe(false);
  });

  it("links tool results to assistant tool calls", () => {
    const entries: RawEntry[] = [
      entry({
        id: "a1",
        type: "message",
        parentId: null,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } }],
        },
      }),
      entry({
        id: "t1",
        type: "message",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "toolResult", toolCallId: "c1", toolName: "bash" },
      }),
    ];
    const tool = buildSlimTree(entries)[0]!.children[0]!.entry;
    expect(tool.toolDisplay).toBe("[bash: ls -la]");
  });
});

describe("extractCopyText", () => {
  it("returns full user text, not the preview cap", () => {
    const body = "hello world " + "x".repeat(500);
    const text = extractCopyText(
      entry({
        id: "u1",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: body }] },
      }),
    );
    expect(text).toBe(body);
  });
});
