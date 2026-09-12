import {
  FILTER_MODES,
  type FilterMode,
  type SlimTreeNode,
} from "./project.js";

export interface Gutter {
  position: number;
  show: boolean;
}

export interface FlatNode {
  node: SlimTreeNode;
  indent: number;
  showConnector: boolean;
  isLast: boolean;
  gutters: Gutter[];
  isVirtualRootChild: boolean;
}

export class TreeView {
  flatNodes: FlatNode[] = [];
  filteredNodes: FlatNode[] = [];
  selectedIndex = 0;
  currentLeafId: string | null;
  filterMode: FilterMode;
  searchQuery = "";
  multipleRoots = false;
  showLabelTimestamps = false;
  activePathIds = new Set<string>();
  visibleParentMap = new Map<string, string | null>();
  visibleChildrenMap = new Map<string | null, string[]>();
  lastSelectedId: string | null = null;
  foldedNodes = new Set<string>();

  constructor(
    tree: SlimTreeNode[],
    currentLeafId: string | null,
    initialSelectedId?: string,
    initialFilterMode?: FilterMode,
  ) {
    this.currentLeafId = currentLeafId;
    this.filterMode = initialFilterMode ?? "default";
    this.multipleRoots = tree.length > 1;
    this.flatNodes = flattenTree(tree, currentLeafId);
    this.buildActivePath();
    this.applyFilter();
    const targetId = initialSelectedId ?? currentLeafId;
    this.selectedIndex = this.findNearestVisibleIndex(targetId);
    this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? null;
  }

  findNearestVisibleIndex(entryId: string | null | undefined): number {
    if (this.filteredNodes.length === 0) return 0;
    const entryMap = new Map<string, FlatNode>();
    for (const flatNode of this.flatNodes) {
      entryMap.set(flatNode.node.entry.id, flatNode);
    }
    const visibleIdToIndex = new Map(
      this.filteredNodes.map((node, i) => [node.node.entry.id, i]),
    );
    let currentId: string | null = entryId ?? null;
    while (currentId !== null) {
      const index = visibleIdToIndex.get(currentId);
      if (index !== undefined) return index;
      const node = entryMap.get(currentId);
      if (!node) break;
      currentId = node.node.entry.parentId ?? null;
    }
    return this.filteredNodes.length - 1;
  }

  buildActivePath(): void {
    this.activePathIds.clear();
    if (!this.currentLeafId) return;
    const entryMap = new Map<string, FlatNode>();
    for (const flatNode of this.flatNodes) {
      entryMap.set(flatNode.node.entry.id, flatNode);
    }
    let currentId: string | null = this.currentLeafId;
    while (currentId) {
      this.activePathIds.add(currentId);
      const node = entryMap.get(currentId);
      if (!node) break;
      currentId = node.node.entry.parentId ?? null;
    }
  }

  applyFilter(): void {
    if (this.filteredNodes.length > 0) {
      this.lastSelectedId =
        this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
    }
    const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
    this.filteredNodes = this.flatNodes.filter((flatNode) => {
      const entry = flatNode.node.entry;
      const isCurrentLeaf = entry.id === this.currentLeafId;
      if (entry.kind === "assistant" && !isCurrentLeaf) {
        if (!entry.hasText && !entry.isErrorOrAborted) return false;
      }
      let passesFilter = true;
      switch (this.filterMode) {
        case "user-only":
          passesFilter = entry.kind === "user";
          break;
        case "no-tools":
          passesFilter = !entry.isSettings && entry.kind !== "toolResult";
          break;
        case "labeled-only":
          passesFilter = entry.label !== undefined;
          break;
        case "all":
          passesFilter = true;
          break;
        default:
          passesFilter = !entry.isSettings;
          break;
      }
      if (!passesFilter) return false;
      if (searchTokens.length > 0) {
        return searchTokens.every((token) => entry.searchText.includes(token));
      }
      return true;
    });

    if (this.foldedNodes.size > 0) {
      const skipSet = new Set<string>();
      for (const flatNode of this.flatNodes) {
        const { id, parentId } = flatNode.node.entry;
        if (parentId != null && (this.foldedNodes.has(parentId) || skipSet.has(parentId))) {
          skipSet.add(id);
        }
      }
      this.filteredNodes = this.filteredNodes.filter(
        (flatNode) => !skipSet.has(flatNode.node.entry.id),
      );
    }

    recalculateVisualStructure(this);

    if (this.lastSelectedId) {
      this.selectedIndex = this.findNearestVisibleIndex(this.lastSelectedId);
    } else if (this.selectedIndex >= this.filteredNodes.length) {
      this.selectedIndex = Math.max(0, this.filteredNodes.length - 1);
    }
    if (this.filteredNodes.length > 0) {
      this.lastSelectedId =
        this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
    }
  }

  getSelected(): SlimTreeNode | undefined {
    return this.filteredNodes[this.selectedIndex]?.node;
  }

  moveUp(): void {
    if (this.filteredNodes.length === 0) return;
    this.selectedIndex =
      this.selectedIndex === 0 ? this.filteredNodes.length - 1 : this.selectedIndex - 1;
  }

  moveDown(): void {
    if (this.filteredNodes.length === 0) return;
    this.selectedIndex =
      this.selectedIndex === this.filteredNodes.length - 1 ? 0 : this.selectedIndex + 1;
  }

  pageUp(pageSize: number): void {
    this.selectedIndex = Math.max(0, this.selectedIndex - pageSize);
  }

  pageDown(pageSize: number): void {
    this.selectedIndex = Math.min(this.filteredNodes.length - 1, this.selectedIndex + pageSize);
  }

  setFilter(mode: FilterMode): void {
    this.filterMode = mode;
    this.foldedNodes.clear();
    this.applyFilter();
  }

  toggleFilter(mode: FilterMode): void {
    this.setFilter(this.filterMode === mode ? "default" : mode);
  }

  cycleFilter(direction: 1 | -1): void {
    const currentIndex = FILTER_MODES.indexOf(this.filterMode);
    const next = (currentIndex + direction + FILTER_MODES.length) % FILTER_MODES.length;
    this.setFilter(FILTER_MODES[next]!);
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.foldedNodes.clear();
    this.applyFilter();
  }

  appendSearch(text: string): void {
    this.setSearchQuery(this.searchQuery + text);
  }

  backspaceSearch(): boolean {
    if (this.searchQuery.length === 0) return false;
    this.setSearchQuery(this.searchQuery.slice(0, -1));
    return true;
  }

  clearSearch(): boolean {
    if (!this.searchQuery) return false;
    this.setSearchQuery("");
    return true;
  }

  foldOrUp(): void {
    const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
    if (currentId && this.isFoldable(currentId) && !this.foldedNodes.has(currentId)) {
      this.foldedNodes.add(currentId);
      this.applyFilter();
    } else {
      this.selectedIndex = this.findBranchSegmentStart("up");
    }
  }

  unfoldOrDown(): void {
    const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
    if (currentId && this.foldedNodes.has(currentId)) {
      this.foldedNodes.delete(currentId);
      this.applyFilter();
    } else {
      this.selectedIndex = this.findBranchSegmentStart("down");
    }
  }

  isFoldable(entryId: string): boolean {
    const children = this.visibleChildrenMap.get(entryId);
    if (!children || children.length === 0) return false;
    const parentId = this.visibleParentMap.get(entryId);
    if (parentId === null || parentId === undefined) return true;
    const siblings = this.visibleChildrenMap.get(parentId);
    return siblings !== undefined && siblings.length > 1;
  }

  findBranchSegmentStart(direction: "up" | "down"): number {
    const selectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
    if (!selectedId) return this.selectedIndex;
    const indexByEntryId = new Map(
      this.filteredNodes.map((node, i) => [node.node.entry.id, i]),
    );
    let currentId = selectedId;
    if (direction === "down") {
      while (true) {
        const children = this.visibleChildrenMap.get(currentId) ?? [];
        if (children.length === 0) return indexByEntryId.get(currentId) ?? this.selectedIndex;
        if (children.length > 1) return indexByEntryId.get(children[0]!) ?? this.selectedIndex;
        currentId = children[0]!;
      }
    }
    while (true) {
      const parentId = this.visibleParentMap.get(currentId) ?? null;
      if (parentId === null) return indexByEntryId.get(currentId) ?? this.selectedIndex;
      const children = this.visibleChildrenMap.get(parentId) ?? [];
      if (children.length > 1) {
        const segmentStart = indexByEntryId.get(currentId);
        if (segmentStart !== undefined && segmentStart < this.selectedIndex) {
          return segmentStart;
        }
      }
      currentId = parentId;
    }
  }

  updateNodeLabel(entryId: string, label: string | undefined, labelTimestamp?: string): void {
    for (const flatNode of this.flatNodes) {
      if (flatNode.node.entry.id === entryId) {
        const e = flatNode.node.entry;
        e.label = label;
        e.labelTimestamp = label ? (labelTimestamp ?? new Date().toISOString()) : undefined;
        e.searchText = [
          e.label,
          e.role,
          e.preview,
          e.toolDisplay,
          e.bashCommand,
          e.errorPreview,
          e.customType,
          e.modelId,
          e.thinkingLevel,
          e.sessionName,
        ]
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .join(" ")
          .toLowerCase();
        break;
      }
    }
  }

  visibleWindow(maxVisibleLines: number): { start: number; end: number } {
    if (this.filteredNodes.length === 0) return { start: 0, end: 0 };
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisibleLines / 2),
        this.filteredNodes.length - maxVisibleLines,
      ),
    );
    const endIndex = Math.min(startIndex + maxVisibleLines, this.filteredNodes.length);
    return { start: startIndex, end: endIndex };
  }
}

type FlattenStackItem = [
  SlimTreeNode,
  number,
  boolean,
  boolean,
  boolean,
  Gutter[],
  boolean,
];

export function flattenTree(roots: SlimTreeNode[], currentLeafId: string | null): FlatNode[] {
  const result: FlatNode[] = [];
  const stack: FlattenStackItem[] = [];
  const containsActive = new Map<SlimTreeNode, boolean>();
  const leafId = currentLeafId;
  {
    const allNodes: SlimTreeNode[] = [];
    const preOrderStack = [...roots];
    while (preOrderStack.length > 0) {
      const node = preOrderStack.pop()!;
      allNodes.push(node);
      for (let i = node.children.length - 1; i >= 0; i--) {
        preOrderStack.push(node.children[i]!);
      }
    }
    for (let i = allNodes.length - 1; i >= 0; i--) {
      const node = allNodes[i]!;
      let has = leafId !== null && node.entry.id === leafId;
      for (const child of node.children) {
        if (containsActive.get(child)) has = true;
      }
      containsActive.set(node, has);
    }
  }

  const multipleRoots = roots.length > 1;
  const orderedRoots = [...roots].sort(
    (a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)),
  );
  for (let i = orderedRoots.length - 1; i >= 0; i--) {
    const isLast = i === orderedRoots.length - 1;
    stack.push([
      orderedRoots[i]!,
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      isLast,
      [],
      multipleRoots,
    ]);
  }

  while (stack.length > 0) {
    const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
      stack.pop()!;
    result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });
    const children = node.children;
    const multipleChildren = children.length > 1;
    const orderedChildren = (() => {
      const prioritized: SlimTreeNode[] = [];
      const rest: SlimTreeNode[] = [];
      for (const child of children) {
        if (containsActive.get(child)) prioritized.push(child);
        else rest.push(child);
      }
      return [...prioritized, ...rest];
    })();
    let childIndent: number;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 0) childIndent = indent + 1;
    else childIndent = indent;
    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters;
    for (let i = orderedChildren.length - 1; i >= 0; i--) {
      const childIsLast = i === orderedChildren.length - 1;
      stack.push([
        orderedChildren[i]!,
        childIndent,
        multipleChildren,
        multipleChildren,
        childIsLast,
        childGutters,
        false,
      ]);
    }
  }
  return result;
}

function recalculateVisualStructure(view: TreeView): void {
  if (view.filteredNodes.length === 0) return;
  const visibleIds = new Set(view.filteredNodes.map((n) => n.node.entry.id));
  const entryMap = new Map<string, FlatNode>();
  for (const flatNode of view.flatNodes) {
    entryMap.set(flatNode.node.entry.id, flatNode);
  }
  const findVisibleAncestor = (nodeId: string): string | null => {
    let currentId = entryMap.get(nodeId)?.node.entry.parentId ?? null;
    while (currentId !== null) {
      if (visibleIds.has(currentId)) return currentId;
      currentId = entryMap.get(currentId)?.node.entry.parentId ?? null;
    }
    return null;
  };
  const visibleParent = new Map<string, string | null>();
  const visibleChildren = new Map<string | null, string[]>();
  visibleChildren.set(null, []);
  for (const flatNode of view.filteredNodes) {
    const nodeId = flatNode.node.entry.id;
    const ancestorId = findVisibleAncestor(nodeId);
    visibleParent.set(nodeId, ancestorId);
    if (!visibleChildren.has(ancestorId)) visibleChildren.set(ancestorId, []);
    visibleChildren.get(ancestorId)!.push(nodeId);
  }
  const visibleRootIds = visibleChildren.get(null)!;
  view.multipleRoots = visibleRootIds.length > 1;
  const filteredNodeMap = new Map<string, FlatNode>();
  for (const flatNode of view.filteredNodes) {
    filteredNodeMap.set(flatNode.node.entry.id, flatNode);
  }
  type StackItem = [string, number, boolean, boolean, boolean, Gutter[], boolean];
  const stack: StackItem[] = [];
  for (let i = visibleRootIds.length - 1; i >= 0; i--) {
    const isLast = i === visibleRootIds.length - 1;
    stack.push([
      visibleRootIds[i]!,
      view.multipleRoots ? 1 : 0,
      view.multipleRoots,
      view.multipleRoots,
      isLast,
      [],
      view.multipleRoots,
    ]);
  }
  while (stack.length > 0) {
    const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
      stack.pop()!;
    const flatNode = filteredNodeMap.get(nodeId);
    if (!flatNode) continue;
    flatNode.indent = indent;
    flatNode.showConnector = showConnector;
    flatNode.isLast = isLast;
    flatNode.gutters = gutters;
    flatNode.isVirtualRootChild = isVirtualRootChild;
    const children = visibleChildren.get(nodeId) || [];
    const multipleChildren = children.length > 1;
    let childIndent: number;
    if (multipleChildren) childIndent = indent + 1;
    else if (justBranched && indent > 0) childIndent = indent + 1;
    else childIndent = indent;
    const connectorDisplayed = showConnector && !isVirtualRootChild;
    const currentDisplayIndent = view.multipleRoots ? Math.max(0, indent - 1) : indent;
    const connectorPosition = Math.max(0, currentDisplayIndent - 1);
    const childGutters = connectorDisplayed
      ? [...gutters, { position: connectorPosition, show: !isLast }]
      : gutters;
    for (let i = children.length - 1; i >= 0; i--) {
      const childIsLast = i === children.length - 1;
      stack.push([
        children[i]!,
        childIndent,
        multipleChildren,
        multipleChildren,
        childIsLast,
        childGutters,
        false,
      ]);
    }
  }
  view.visibleParentMap = visibleParent;
  view.visibleChildrenMap = visibleChildren;
}
