/**
 * pi-fast-tree — Fast session tree navigator for pi
 *
 * Replaces built-in /tree with a slim in-memory projection: ids, topology,
 * capped previews, and a precomputed search haystack. Never walks full tool
 * arguments or materializes whole message bodies to paint a row.
 *
 * Usage:
 *   /fast-tree              Open picker (when hijackTree is false)
 *   /tree                   Opens the fast picker in hijack mode (default)
 *
 * Config (~/.pi/agent/extensions/pi-fast-tree.json):
 *   { "hijackTree": false, "shortcut": "ctrl+shift+t" }
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  InteractiveMode,
  copyToClipboard,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSlimTree,
  extractCopyText,
  FILTER_MODES,
  type FilterMode,
  type RawEntry,
} from "./src/project.js";
import { FastTreeSelector, type FastTreeResult } from "./src/selector.js";

interface FastTreeConfig {
  hijackTree?: boolean;
  shortcut?: string;
}

const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-fast-tree.json");

function readConfig(): FastTreeConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FastTreeConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readSettingsFilterMode(): FilterMode {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return "default";
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { treeFilterMode?: string };
    const mode = parsed.treeFilterMode;
    if (mode && (FILTER_MODES as string[]).includes(mode)) return mode as FilterMode;
  } catch {
    /* ignore */
  }
  return "default";
}

function readSkipBranchSummaryPrompt(): boolean {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return false;
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      branchSummarySkipPrompt?: boolean;
    };
    return parsed.branchSummarySkipPrompt === true;
  } catch {
    return false;
  }
}

function appendLabelChange(
  ctx: ExtensionCommandContext,
  entryId: string,
  label: string | undefined,
): void {
  const sm = ctx.sessionManager as unknown as {
    appendLabelChange?: (id: string, label: string | undefined) => string;
  };
  sm.appendLabelChange?.(entryId, label);
}

function getRawEntries(ctx: ExtensionCommandContext): RawEntry[] {
  return ctx.sessionManager.getEntries() as unknown as RawEntry[];
}

async function copyEntry(ctx: ExtensionCommandContext, entryId: string): Promise<void> {
  const entry = ctx.sessionManager.getEntry(entryId) as unknown as RawEntry | undefined;
  const text = entry ? extractCopyText(entry) : undefined;
  if (!text) {
    ctx.ui.notify("Selected entry has no text to copy", "error");
    return;
  }
  try {
    await copyToClipboard(text);
    ctx.ui.notify("Copied selected message to clipboard", "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

async function navigateFromSelection(
  ctx: ExtensionCommandContext,
  entryId: string,
  options: { skipSummaryPrompt: boolean; initialFilterMode: FilterMode },
): Promise<void> {
  if (entryId === ctx.sessionManager.getLeafId()) {
    ctx.ui.notify("Already at this point", "info");
    return;
  }

  let wantsSummary = false;
  let customInstructions: string | undefined;
  if (!options.skipSummaryPrompt) {
    while (true) {
      const summaryChoice = await ctx.ui.select("Summarize branch?", [
        "No summary",
        "Summarize",
        "Summarize with custom prompt",
      ]);
      if (summaryChoice === undefined) {
        await showFastTreePicker(ctx, {
          initialSelectedId: entryId,
          initialFilterMode: options.initialFilterMode,
        });
        return;
      }
      wantsSummary = summaryChoice !== "No summary";
      if (summaryChoice === "Summarize with custom prompt") {
        customInstructions = await ctx.ui.editor("Custom summarization instructions");
        if (customInstructions === undefined) continue;
      }
      break;
    }
  }

  if (!ctx.isIdle()) {
    ctx.abort();
    await ctx.waitForIdle();
  }

  try {
    const result = await ctx.navigateTree(entryId, {
      summarize: wantsSummary,
      customInstructions,
    });
    if (result.cancelled) {
      ctx.ui.notify("Navigation cancelled", "info");
    }
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

export async function showFastTreePicker(
  ctx: ExtensionCommandContext,
  options?: { initialSelectedId?: string; initialFilterMode?: FilterMode },
): Promise<void> {
  const entries = getRawEntries(ctx);
  if (entries.length === 0) {
    ctx.ui.notify("No entries in session", "info");
    return;
  }

  const t0 = Date.now();
  const tree = buildSlimTree(entries);
  const loadTime = Date.now() - t0;
  ctx.ui.notify(`Fast tree: ${entries.length} entries in ${loadTime}ms`, "info");

  const initialFilterMode = options?.initialFilterMode ?? readSettingsFilterMode();
  const skipSummaryPrompt = readSkipBranchSummaryPrompt();
  const leafId = ctx.sessionManager.getLeafId();

  if (ctx.mode !== "tui") {
    if (!ctx.hasUI) return;
    const userNodes = tree.flatMap(function collect(node): { id: string; label: string }[] {
      const self =
        node.entry.kind === "user"
          ? [{ id: node.entry.id, label: node.entry.preview || node.entry.id }]
          : [];
      return self.concat(node.children.flatMap(collect));
    });
    if (userNodes.length === 0) {
      ctx.ui.notify("No user messages in session tree.", "info");
      return;
    }
    const items = userNodes.map((n) => n.label);
    const pick = await ctx.ui.select("Fast tree — jump to message", items);
    if (pick === undefined) return;
    const idx = items.indexOf(pick);
    const node = userNodes[idx];
    if (node) {
      await navigateFromSelection(ctx, node.id, { skipSummaryPrompt, initialFilterMode });
    }
    return;
  }

  const result = await ctx.ui.custom<FastTreeResult>((tui, theme, _kb, done) => {
    const selector = new FastTreeSelector(
      tree,
      leafId,
      theme,
      tui.terminal.rows,
      (entryId) => done({ action: "select", entryId }),
      () => done({ action: "cancel" }),
      (entryId, label) => appendLabelChange(ctx, entryId, label),
      options?.initialSelectedId,
      initialFilterMode,
    );
    selector.onCopy = (entryId) => {
      void copyEntry(ctx, entryId);
    };
    return selector;
  });

  if (result && result.action === "select") {
    await navigateFromSelection(ctx, result.entryId, { skipSummaryPrompt, initialFilterMode });
  }
}

import { installInteractivePatch } from "./src/interactive-patch.js";

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  const hijack = config.hijackTree !== false;
  let runner: { createCommandContext(): ExtensionCommandContext } | undefined;
  let restores: Array<() => void> = [];

  // Pi 1.0 binds session_start before setupExtensionShortcuts, including
  // session replacement. Factories loaded for discovery must not patch the UI.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || restores.length) return;
    try {
      if (hijack) restores.push(installInteractivePatch(InteractiveMode.prototype, "showTreeSelector", function (original, ...args) {
        const currentRunner = this.session?.extensionRunner;
        if (!currentRunner?.createCommandContext) return original.apply(this, args);
        return showFastTreePicker(currentRunner.createCommandContext(), { initialSelectedId: args[0] as string | undefined, initialFilterMode: this.settingsManager.getTreeFilterMode() }).catch((error: unknown) => {
          ctx.ui.notify(`Fast tree: ${String(error)}`, "error");
        });
      }));
      if (config.shortcut) restores.push(installInteractivePatch(InteractiveMode.prototype, "setupExtensionShortcuts", function (original, extensionRunner) {
        runner = extensionRunner;
        return original.call(this, extensionRunner);
      }));
    } catch (error) {
      for (const restore of restores.reverse()) restore();
      restores = [];
      ctx.ui.notify(String(error), "warning");
    }
  });

  if (!hijack) pi.registerCommand("fast-tree", {
    description: "Fast session tree",
    handler: async (args, ctx) => { await showFastTreePicker(ctx); },
  });
  if (config.shortcut) pi.registerShortcut(config.shortcut as KeyId, {
    description: "Fast session tree",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;
      if (!runner) { ctx.ui.notify("Fast tree: session shortcuts are not bound", "error"); return; }
      await showFastTreePicker(runner.createCommandContext());
    },
  });
  pi.on("session_shutdown", () => {
    for (const restore of restores.reverse()) restore();
    restores = [];
    runner = undefined;
  });
}
