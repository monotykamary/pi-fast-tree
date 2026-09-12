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

let storedExtensionRunner: {
  createCommandContext?: () => ExtensionCommandContext;
} | null = null;
let origShowTreeSelector: ((this: InteractiveMode, initialSelectedId?: string) => void) | null =
  null;
let origSetupExtensionShortcuts: Function | null = null;

function patchSetupExtensionShortcuts(): void {
  if (origSetupExtensionShortcuts !== null) return;
  const proto = InteractiveMode.prototype as any;
  if (
    !InteractiveMode ||
    typeof InteractiveMode !== "function" ||
    typeof proto.setupExtensionShortcuts !== "function"
  ) {
    return;
  }
  origSetupExtensionShortcuts = proto.setupExtensionShortcuts;
  proto.setupExtensionShortcuts = function (this: InteractiveMode, extensionRunner: any) {
    storedExtensionRunner = extensionRunner;
    origSetupExtensionShortcuts!.call(this, extensionRunner);
  };
}

function unpatchSetupExtensionShortcuts(): void {
  if (origSetupExtensionShortcuts === null) return;
  const proto = InteractiveMode.prototype as any;
  if (
    InteractiveMode &&
    typeof InteractiveMode === "function" &&
    typeof proto.setupExtensionShortcuts === "function"
  ) {
    proto.setupExtensionShortcuts = origSetupExtensionShortcuts;
  }
  origSetupExtensionShortcuts = null;
  storedExtensionRunner = null;
}

function installTreeHijack(): void {
  if (origShowTreeSelector !== null) return;
  const proto = InteractiveMode.prototype as any;
  if (
    !InteractiveMode ||
    typeof InteractiveMode !== "function" ||
    typeof proto.showTreeSelector !== "function"
  ) {
    return;
  }
  origShowTreeSelector = proto.showTreeSelector;
  proto.showTreeSelector = function (this: InteractiveMode, initialSelectedId?: string) {
    const session = (this as any).session;
    if (!session?.extensionRunner?.createCommandContext) {
      origShowTreeSelector!.call(this, initialSelectedId);
      return;
    }
    const ctx = session.extensionRunner.createCommandContext() as ExtensionCommandContext;
    const settingsManager = (this as any).settingsManager;
    const initialFilterMode =
      typeof settingsManager?.getTreeFilterMode === "function"
        ? (settingsManager.getTreeFilterMode() as FilterMode)
        : readSettingsFilterMode();
    void showFastTreePicker(ctx, { initialSelectedId, initialFilterMode });
  };
}

function uninstallTreeHijack(): void {
  if (origShowTreeSelector === null) return;
  const proto = InteractiveMode.prototype as any;
  if (
    InteractiveMode &&
    typeof InteractiveMode === "function" &&
    typeof proto.showTreeSelector === "function"
  ) {
    proto.showTreeSelector = origShowTreeSelector;
  }
  origShowTreeSelector = null;
}

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  const hijackTree = config.hijackTree !== false;

  if (hijackTree) {
    installTreeHijack();
  } else {
    pi.registerCommand("fast-tree", {
      description: "Fast session tree — slim projection, same navigator as /tree",
      handler: async (_args, ctx) => {
        await showFastTreePicker(ctx);
      },
    });
  }

  const shortcut = config.shortcut;
  if (shortcut) {
    patchSetupExtensionShortcuts();
    pi.registerShortcut(shortcut as KeyId, {
      description: "Fast session tree",
      handler: async (ctx) => {
        if (
          !storedExtensionRunner ||
          typeof storedExtensionRunner.createCommandContext !== "function"
        ) {
          ctx.ui.notify(
            "Fast tree shortcut: extension runner not available. Try reloading with /reload.",
            "error",
          );
          return;
        }
        const cmdCtx = storedExtensionRunner.createCommandContext() as ExtensionCommandContext;
        await showFastTreePicker(cmdCtx);
      },
    });
  }

  pi.on("session_shutdown", () => {
    if (hijackTree) uninstallTreeHijack();
    if (shortcut) unpatchSetupExtensionShortcuts();
  });
}
