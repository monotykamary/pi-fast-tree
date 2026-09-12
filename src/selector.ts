import {
  Container,
  getKeybindings,
  Input,
  Spacer,
  Text,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  DynamicBorder,
  Theme,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import type { FilterMode, SlimTreeNode } from "./project.js";
import { TreeView, type FlatNode } from "./tree.js";

const TREE_GUTTER_WIDTH = 2;
const MIN_VISIBLE_ANCHOR_CONTENT_WIDTH = 4;
const MAX_VISIBLE_ANCHOR_CONTENT_WIDTH = 20;
const MIN_ANCHOR_CONTEXT_WIDTH = 2;
const MAX_ANCHOR_CONTEXT_WIDTH = 12;

interface RenderedRow {
  gutter: string;
  body: string;
  anchorCol: number;
  bodyWidth: number;
  isSelected: boolean;
}

function renderHorizontalViewport(rows: RenderedRow[], width: number): string[] {
  const viewportWidth = Math.max(0, width - TREE_GUTTER_WIDTH);
  const maxBodyWidth = rows.reduce((max, row) => Math.max(max, row.bodyWidth), 0);
  const maxHorizontalScroll = Math.max(0, maxBodyWidth - viewportWidth);
  const selectedRow = rows.find((row) => row.isSelected);
  let horizontalScroll = 0;
  if (selectedRow && maxHorizontalScroll > 0) {
    const minVisibleAnchorContentWidth = Math.min(
      MAX_VISIBLE_ANCHOR_CONTENT_WIDTH,
      Math.max(MIN_VISIBLE_ANCHOR_CONTENT_WIDTH, Math.floor(viewportWidth / 3)),
    );
    if (selectedRow.anchorCol > viewportWidth - minVisibleAnchorContentWidth) {
      const anchorContextWidth = Math.min(
        MAX_ANCHOR_CONTEXT_WIDTH,
        Math.max(MIN_ANCHOR_CONTEXT_WIDTH, Math.floor(viewportWidth / 4)),
      );
      horizontalScroll = Math.min(maxHorizontalScroll, selectedRow.anchorCol - anchorContextWidth);
    }
  }
  return rows.map((row) => {
    const line =
      horizontalScroll > 0
        ? `${row.gutter}${sliceByColumn(row.body, horizontalScroll, viewportWidth, true)}\x1b[0m`
        : row.gutter + row.body;
    return truncateToWidth(line, width, "");
  });
}

export function formatLabelTimestamp(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const time = `${hours}:${minutes}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) {
    return `${month}/${day} ${time}`;
  }
  const year = date.getFullYear().toString().slice(-2);
  return `${year}/${month}/${day} ${time}`;
}

export function getEntryDisplayText(node: SlimTreeNode, theme: Theme, isSelected: boolean): string {
  const entry = node.entry;
  let result: string;
  switch (entry.kind) {
    case "user":
      result = theme.fg("accent", "user: ") + entry.preview;
      break;
    case "assistant":
      if (entry.preview) {
        result = theme.fg("success", "assistant: ") + entry.preview;
      } else if (entry.isErrorOrAborted && entry.errorPreview) {
        result = theme.fg("success", "assistant: ") + theme.fg("error", entry.errorPreview);
      } else if (entry.isErrorOrAborted) {
        result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
      } else {
        result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
      }
      break;
    case "toolResult":
      result = theme.fg("muted", entry.toolDisplay ?? `[${entry.toolName ?? "tool"}]`);
      break;
    case "bashExecution":
      result = theme.fg("dim", `[bash]: ${entry.preview}`);
      break;
    case "otherMessage":
      result = theme.fg("dim", `[${entry.role ?? "message"}]`);
      break;
    case "custom_message":
      result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + entry.preview;
      break;
    case "compaction": {
      const tokens = Math.round((entry.tokensBefore ?? 0) / 1000);
      result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
      break;
    }
    case "branch_summary":
      result = theme.fg("warning", `[branch summary]: `) + entry.preview;
      break;
    case "model_change":
      result = theme.fg("dim", `[model: ${entry.modelId}]`);
      break;
    case "thinking_level_change":
      result = theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
      break;
    case "custom":
      result = theme.fg("dim", `[custom: ${entry.customType}]`);
      break;
    case "label":
      result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
      break;
    case "session_info":
      result = entry.sessionName
        ? theme.fg("dim", `[title: ${entry.sessionName}]`)
        : [theme.fg("dim", "[title: "), theme.italic(theme.fg("dim", "empty")), theme.fg("dim", "]")].join("");
      break;
    default:
      result = "";
  }
  return isSelected ? theme.bold(result) : result;
}

function getStatusLabels(view: TreeView): string {
  let labels = "";
  switch (view.filterMode) {
    case "no-tools":
      labels += " [no-tools]";
      break;
    case "user-only":
      labels += " [user]";
      break;
    case "labeled-only":
      labels += " [labeled]";
      break;
    case "all":
      labels += " [all]";
      break;
  }
  if (view.showLabelTimestamps) labels += " [+label time]";
  return labels;
}

class TreeList implements Component {
  view: TreeView;
  theme: Theme;
  private maxVisibleLines: number;
  onSelect?: (entryId: string) => void;
  onCancel?: () => void;
  onCopy?: () => void;
  onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

  constructor(view: TreeView, theme: Theme, maxVisibleLines: number) {
    this.view = view;
    this.theme = theme;
    this.maxVisibleLines = maxVisibleLines;
  }

  invalidate(): void {}

  getSearchQuery(): string {
    return this.view.searchQuery;
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    if (this.view.filteredNodes.length === 0) {
      lines.push(truncateToWidth(t.fg("muted", "  No entries found"), width));
      lines.push(truncateToWidth(t.fg("muted", `  (0/0)${getStatusLabels(this.view)}`), width));
      return lines;
    }
    const { start, end } = this.view.visibleWindow(this.maxVisibleLines);
    const renderedRows: RenderedRow[] = [];
    for (let i = start; i < end; i++) {
      renderedRows.push(this.renderRow(this.view.filteredNodes[i]!, i === this.view.selectedIndex));
    }
    lines.push(...renderHorizontalViewport(renderedRows, width));
    lines.push(
      truncateToWidth(
        t.fg(
          "muted",
          `  (${this.view.selectedIndex + 1}/${this.view.filteredNodes.length})${getStatusLabels(this.view)}`,
        ),
        width,
      ),
    );
    return lines;
  }

  private renderRow(flatNode: FlatNode, isSelected: boolean): RenderedRow {
    const t = this.theme;
    const entry = flatNode.node.entry;
    const cursor = isSelected ? t.fg("accent", "› ") : "  ";
    const displayIndent = this.view.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
    const connector = flatNode.showConnector && !flatNode.isVirtualRootChild
      ? (flatNode.isLast ? "└─ " : "├─ ")
      : "";
    const connectorPosition = connector ? displayIndent - 1 : -1;
    const totalChars = displayIndent * 3;
    const prefixChars: string[] = [];
    const isFolded = this.view.foldedNodes.has(entry.id);
    for (let i = 0; i < totalChars; i++) {
      const level = Math.floor(i / 3);
      const posInLevel = i % 3;
      const gutter = flatNode.gutters.find((g) => g.position === level);
      if (gutter) {
        prefixChars.push(posInLevel === 0 ? (gutter.show ? "│" : " ") : " ");
      } else if (connector && level === connectorPosition) {
        if (posInLevel === 0) prefixChars.push(flatNode.isLast ? "└" : "├");
        else if (posInLevel === 1) {
          const foldable = this.view.isFoldable(entry.id);
          prefixChars.push(isFolded ? "⊞" : foldable ? "⊟" : "─");
        } else prefixChars.push(" ");
      } else {
        prefixChars.push(" ");
      }
    }
    const prefix = prefixChars.join("");
    const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
    const foldMarker = isFolded && !showsFoldInConnector ? t.fg("accent", "⊞ ") : "";
    const pathMarker = this.view.activePathIds.has(entry.id) ? t.fg("accent", "• ") : "";
    const label = entry.label ? t.fg("warning", `[${entry.label}] `) : "";
    const labelTimestamp =
      this.view.showLabelTimestamps && entry.label && entry.labelTimestamp
        ? t.fg("muted", `${formatLabelTimestamp(entry.labelTimestamp)} `)
        : "";
    const content = getEntryDisplayText(flatNode.node, t, isSelected);
    const prefixPart = t.fg("dim", prefix) + foldMarker + pathMarker;
    const anchorCol = visibleWidth(prefixPart);
    let gutter = cursor;
    let body = prefixPart + label + labelTimestamp + content;
    if (isSelected) {
      gutter = t.bg("selectedBg", gutter);
      body = t.bg("selectedBg", body);
    }
    return { gutter, body, anchorCol, bodyWidth: visibleWidth(body), isSelected };
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.up")) {
      this.view.moveUp();
    } else if (kb.matches(keyData, "tui.select.down")) {
      this.view.moveDown();
    } else if (kb.matches(keyData, "app.tree.foldOrUp")) {
      this.view.foldOrUp();
    } else if (kb.matches(keyData, "app.tree.unfoldOrDown")) {
      this.view.unfoldOrDown();
    } else if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.select.pageUp")) {
      this.view.pageUp(this.maxVisibleLines);
    } else if (kb.matches(keyData, "tui.editor.cursorRight") || kb.matches(keyData, "tui.select.pageDown")) {
      this.view.pageDown(this.maxVisibleLines);
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      const selected = this.view.getSelected();
      if (selected) this.onSelect?.(selected.entry.id);
    } else if (kb.matches(keyData, "app.message.copy")) {
      this.onCopy?.();
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      if (!this.view.clearSearch()) this.onCancel?.();
    } else if (kb.matches(keyData, "app.tree.filter.default")) {
      this.view.setFilter("default");
    } else if (kb.matches(keyData, "app.tree.filter.noTools")) {
      this.view.toggleFilter("no-tools");
    } else if (kb.matches(keyData, "app.tree.filter.userOnly")) {
      this.view.toggleFilter("user-only");
    } else if (kb.matches(keyData, "app.tree.filter.labeledOnly")) {
      this.view.toggleFilter("labeled-only");
    } else if (kb.matches(keyData, "app.tree.filter.all")) {
      this.view.toggleFilter("all");
    } else if (kb.matches(keyData, "app.tree.filter.cycleBackward")) {
      this.view.cycleFilter(-1);
    } else if (kb.matches(keyData, "app.tree.filter.cycleForward")) {
      this.view.cycleFilter(1);
    } else if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
      this.view.backspaceSearch();
    } else if (kb.matches(keyData, "app.tree.editLabel")) {
      const selected = this.view.getSelected();
      if (selected) this.onLabelEdit?.(selected.entry.id, selected.entry.label);
    } else if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
      this.view.showLabelTimestamps = !this.view.showLabelTimestamps;
    } else {
      const hasControlChars = [...keyData].some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      });
      if (!hasControlChars && keyData.length > 0) this.view.appendSearch(keyData);
    }
  }
}

class SearchLine implements Component {
  constructor(private treeList: TreeList) {}
  invalidate(): void {}
  render(width: number): string[] {
    const t = this.treeList.theme;
    const query = this.treeList.getSearchQuery();
    if (query) {
      return [
        truncateToWidth("  " + t.fg("muted", "Type to search:") + " " + t.fg("accent", query), width),
      ];
    }
    return [truncateToWidth("  " + t.fg("muted", "Type to search:"), width)];
  }
  handleInput(_keyData: string): void {}
}

const TREE_HELP_ITEMS: Array<{ keys: string[]; label: string; labelFirst?: boolean }> = [
  { keys: ["tui.select.up", "tui.select.down"], label: "move" },
  { keys: ["tui.editor.cursorLeft", "tui.editor.cursorRight"], label: "page" },
  { keys: ["app.tree.foldOrUp", "app.tree.unfoldOrDown"], label: "branch" },
  { keys: ["app.message.copy"], label: "copy" },
  { keys: ["app.tree.editLabel"], label: "label" },
  { keys: ["app.tree.toggleLabelTimestamp"], label: "label time" },
  {
    keys: [
      "app.tree.filter.default",
      "app.tree.filter.noTools",
      "app.tree.filter.userOnly",
      "app.tree.filter.labeledOnly",
      "app.tree.filter.all",
    ],
    label: "filters",
    labelFirst: true,
  },
  { keys: ["app.tree.filter.cycleForward", "app.tree.filter.cycleBackward"], label: "cycle", labelFirst: true },
];

function formatKeyText(key: string): string {
  return key
    .replace(/\bpageUp\b/g, "pgup")
    .replace(/\bpageDown\b/g, "pgdn")
    .replace(/\bup\b/g, "↑")
    .replace(/\bdown\b/g, "↓")
    .replace(/\bleft\b/g, "←")
    .replace(/\bright\b/g, "→");
}

function compactRawKeys(keys: string[]): string {
  if (keys.length === 1) return keys[0]!;
  const parts = keys.map((key) => {
    const separatorIndex = key.lastIndexOf("+");
    return separatorIndex === -1
      ? { prefix: "", suffix: key }
      : { prefix: key.slice(0, separatorIndex + 1), suffix: key.slice(separatorIndex + 1) };
  });
  const prefix = parts[0]!.prefix;
  return prefix && parts.every((part) => part.prefix === prefix)
    ? `${prefix}${parts.map((part) => part.suffix).join("/")}`
    : keys.join("/");
}

function formatHelpKeys(keybindings: string[]): string {
  const keys: string[] = [];
  for (const keybinding of keybindings) {
    const key = getKeybindings().getKeys(keybinding as never)[0];
    if (key !== undefined) keys.push(key);
  }
  if (keys.length === 0) return "";
  return formatKeyText(compactRawKeys(keys));
}

class TreeHelp implements Component {
  constructor(private theme: Theme) {}
  invalidate(): void {}
  render(width: number): string[] {
    const items = TREE_HELP_ITEMS.map(({ keys, label, labelFirst }) => {
      const text = formatHelpKeys(keys);
      if (!text) return label;
      return labelFirst ? `${label} ${text}` : `${text} ${label}`;
    });
    const availableWidth = Math.max(1, width);
    const indent = "  ";
    const separator = " · ";
    const lines: string[] = [];
    let currentLine = "";
    for (const item of items) {
      const candidate = currentLine
        ? `${currentLine}${separator}${item}`
        : visibleWidth(`${indent}${item}`) <= availableWidth
          ? `${indent}${item}`
          : item;
      if (!currentLine || visibleWidth(candidate) <= availableWidth) {
        currentLine = candidate;
        continue;
      }
      lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));
      currentLine = visibleWidth(`${indent}${item}`) <= availableWidth ? `${indent}${item}` : item;
    }
    if (currentLine) lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));
    return lines.map((line) => this.theme.fg("muted", line));
  }
  handleInput(_keyData: string): void {}
}

class LabelInput implements Component {
  input: Input;
  entryId: string;
  onSubmit?: (entryId: string, label: string | undefined) => void;
  onCancel?: () => void;
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }
  constructor(entryId: string, currentLabel: string | undefined) {
    this.entryId = entryId;
    this.input = new Input();
    if (currentLabel) this.input.setValue(currentLabel);
  }
  invalidate(): void {}
  render(width: number): string[] {
    const lines: string[] = [];
    const indent = "  ";
    const availableWidth = width - indent.length;
    lines.push(truncateToWidth(`${indent}Label (empty to remove):`, width));
    lines.push(...this.input.render(availableWidth).map((line) => truncateToWidth(`${indent}${line}`, width)));
    lines.push(
      truncateToWidth(
        `${indent}${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "cancel")}`,
        width,
      ),
    );
    return lines;
  }
  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.confirm")) {
      const value = this.input.getValue().trim();
      this.onSubmit?.(this.entryId, value || undefined);
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.onCancel?.();
    } else {
      this.input.handleInput(keyData);
    }
  }
}

export type FastTreeResult =
  | { action: "select"; entryId: string }
  | { action: "cancel" };

export class FastTreeSelector extends Container {
  private treeList: TreeList;
  private labelInput: LabelInput | null = null;
  private labelInputContainer: Container;
  private treeContainer: Container;
  private onLabelChangeCallback?: (entryId: string, label: string | undefined) => void;
  onCopy?: (entryId: string) => void;
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (this.labelInput) this.labelInput.focused = value;
  }

  constructor(
    tree: SlimTreeNode[],
    currentLeafId: string | null,
    theme: Theme,
    terminalHeight: number,
    onSelect: (entryId: string) => void,
    onCancel: () => void,
    onLabelChange?: (entryId: string, label: string | undefined) => void,
    initialSelectedId?: string,
    initialFilterMode?: FilterMode,
  ) {
    super();
    this.onLabelChangeCallback = onLabelChange;
    const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));
    const view = new TreeView(tree, currentLeafId, initialSelectedId, initialFilterMode);
    this.treeList = new TreeList(view, theme, maxVisibleLines);
    this.treeList.onSelect = onSelect;
    this.treeList.onCancel = onCancel;
    this.treeList.onCopy = () => {
      const selected = view.getSelected();
      if (selected) this.onCopy?.(selected.entry.id);
    };
    this.treeList.onLabelEdit = (entryId, currentLabel) => this.showLabelInput(entryId, currentLabel);
    this.treeContainer = new Container();
    this.treeContainer.addChild(this.treeList);
    this.labelInputContainer = new Container();
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.addChild(new Text(theme.bold("  Session Tree"), 1, 0));
    this.addChild(new TreeHelp(theme));
    this.addChild(new SearchLine(this.treeList));
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(this.treeContainer);
    this.addChild(this.labelInputContainer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
  }

  private showLabelInput(entryId: string, currentLabel: string | undefined): void {
    this.labelInput = new LabelInput(entryId, currentLabel);
    this.labelInput.onSubmit = (id, label) => {
      this.treeList.view.updateNodeLabel(id, label);
      this.onLabelChangeCallback?.(id, label);
      this.hideLabelInput();
    };
    this.labelInput.onCancel = () => this.hideLabelInput();
    this.labelInput.focused = this._focused;
    this.treeContainer.clear();
    this.labelInputContainer.clear();
    this.labelInputContainer.addChild(this.labelInput);
  }

  private hideLabelInput(): void {
    this.labelInput = null;
    this.labelInputContainer.clear();
    this.treeContainer.clear();
    this.treeContainer.addChild(this.treeList);
  }

  handleInput(keyData: string): void {
    if (this.labelInput) this.labelInput.handleInput(keyData);
    else this.treeList.handleInput(keyData);
  }
}
