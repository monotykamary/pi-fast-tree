import { describe, it, expect } from "vitest";
import { buildSlimTree, type RawEntry } from "../src/project.js";
import { TreeView } from "../src/tree.js";

function msg(
  id: string,
  parentId: string | null,
  role: string,
  text: string,
  timestamp = "2026-01-01T00:00:00.000Z",
): RawEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role, content: [{ type: "text", text }] },
  };
}

function toolOnlyAssistant(id: string, parentId: string): RawEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc", name: "read", arguments: { path: "/x" } }],
    },
  };
}

describe("TreeView", () => {
  it("matches Pi 0.99 usage and context-edit filtering without retaining replacement payloads", () => {
    const tree = buildSlimTree([
      msg("user", null, "user", "hi"),
      { type: "usage", id: "usage", parentId: "user", timestamp: "2026-01-01" },
      { type: "context_edit", id: "edit", parentId: "usage", timestamp: "2026-01-02", targetId: "user", replacement: null },
    ]);
    const view = new TreeView(tree, "edit");
    expect(view.filteredNodes.map(n => n.node.entry.id)).toEqual(["user"]);
    view.setFilter("all");
    expect(view.filteredNodes.map(n => n.node.entry.id)).toEqual(["user", "edit"]);
    view.setSearchQuery("context omit user");
    expect(view.filteredNodes.map(n => n.node.entry.preview)).toEqual(["[context omit: user]"]);
    expect(view.filteredNodes[0]!.node.entry).not.toHaveProperty("replacement");
  });
  it("hides tool-only assistant rows in default filter except the current leaf", () => {
    const tree = buildSlimTree([
      msg("u1", null, "user", "hi"),
      toolOnlyAssistant("a1", "u1"),
      msg("u2", "a1", "user", "next", "2026-01-01T00:00:02.000Z"),
    ]);
    const view = new TreeView(tree, "u2");
    expect(view.filteredNodes.map((n) => n.node.entry.id)).toEqual(["u1", "u2"]);

    const atLeaf = new TreeView(tree, "a1");
    expect(atLeaf.filteredNodes.map((n) => n.node.entry.id)).toContain("a1");
  });

  it("filters user-only and searches the precomputed haystack", () => {
    const tree = buildSlimTree([
      msg("u1", null, "user", "fix oauth bug"),
      msg("a1", "u1", "assistant", "sure", "2026-01-01T00:00:01.000Z"),
      msg("u2", "a1", "user", "thanks", "2026-01-01T00:00:02.000Z"),
    ]);
    const view = new TreeView(tree, "u2");
    view.setFilter("user-only");
    expect(view.filteredNodes.map((n) => n.node.entry.kind)).toEqual(["user", "user"]);
    view.appendSearch("oauth");
    expect(view.filteredNodes.map((n) => n.node.entry.id)).toEqual(["u1"]);
  });

  it("does not scan message bodies on each search keystroke", () => {
    const blob = "secret-token-" + "n".repeat(100_000);
    const tree = buildSlimTree([
      msg("u1", null, "user", "hello"),
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: blob }] },
      },
    ]);
    const view = new TreeView(tree, "a1");
    view.appendSearch("secret-token");
    expect(view.filteredNodes.some((n) => n.node.entry.id === "a1")).toBe(true);
    view.setSearchQuery("zzzz-not-in-preview");
    expect(view.filteredNodes).toHaveLength(0);
  });

  it("folds descendants and jumps along branch segments", () => {
    const tree = buildSlimTree([
      msg("u1", null, "user", "root"),
      msg("a1", "u1", "assistant", "A", "2026-01-01T00:00:01.000Z"),
      msg("u2", "a1", "user", "branch a", "2026-01-01T00:00:02.000Z"),
      msg("u3", "a1", "user", "branch b", "2026-01-01T00:00:03.000Z"),
    ]);
    const view = new TreeView(tree, "u2");
    expect(view.filteredNodes.length).toBe(4);
    // Root with children is foldable; a linear-chain branch point is not
    // (matches built-in /tree: foldable = has visible children AND is a
    // root or a segment start).
    view.selectedIndex = view.filteredNodes.findIndex((n) => n.node.entry.id === "u1");
    view.foldOrUp();
    expect(view.filteredNodes.map((n) => n.node.entry.id)).toEqual(["u1"]);
    view.unfoldOrDown();
    expect(view.filteredNodes.length).toBe(4);
  });

  it("projects 5k huge entries quickly", () => {
    const blob = "Q".repeat(20_000);
    const entries: RawEntry[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 5000; i++) {
      const id = "e" + String(i);
      entries.push({
        type: "message",
        id,
        parentId: parent,
        timestamp: "2026-01-01T00:00:00." + String(i).padStart(3, "0") + "Z",
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: blob }],
        },
      });
      parent = id;
    }
    const t0 = Date.now();
    const tree = buildSlimTree(entries);
    const view = new TreeView(tree, "e4999");
    view.appendSearch("qq");
    const ms = Date.now() - t0;
    expect(view.flatNodes).toHaveLength(5000);
    expect(ms).toBeLessThan(1500);
  });
});
