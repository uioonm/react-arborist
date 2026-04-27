import { EditResult } from "../types/handlers";
import { Identity, IdObj } from "../types/utils";
import { TreeProps } from "../types/tree-props";
import { MutableRefObject } from "react";
import { Align, FixedSizeList, ListOnItemsRenderedProps } from "react-window";
import * as utils from "../utils";
import { DefaultCursor } from "../components/default-cursor";
import { DefaultRow } from "../components/default-row";
import { DefaultNode } from "../components/default-node";
import { NodeApi } from "./node-api";
import { edit } from "../state/edit-slice";
import { Actions, RootState } from "../state/root-reducer";
import { focus, treeBlur } from "../state/focus-slice";
import { createRoot, ROOT_ID } from "../data/create-root";
import { actions as visibility } from "../state/open-slice";
import { actions as selection } from "../state/selection-slice";
import { actions as checked } from "../state/checked-slice";
import { actions as dnd } from "../state/dnd-slice";
import { DefaultDragPreview } from "../components/default-drag-preview";
import { DefaultContainer } from "../components/default-container";
import { Cursor } from "../dnd/compute-drop";
import { Store } from "redux";
import { createList } from "../data/create-list";
import { createIndex } from "../data/create-index";

const { safeRun, identify, identifyNull } = utils;
const EMPTY_IDS = new Set<string>();

export class TreeApi<T> {
  static editPromise: null | ((args: EditResult) => void);
  root: NodeApi<T>;
  visibleNodes: NodeApi<T>[];
  visibleStartIndex: number = 0;
  visibleStopIndex: number = 0;
  idToIndex: { [id: string]: number };
  private checkedStateCache: {
    root: NodeApi<T>;
    sourceIds: Set<string>; // The raw checked ids from state, used to determine cache validity
    checkStrictly: boolean;
    checkedIds: Set<string>;
    halfCheckedIds: Set<string>;
  } | null = null;

  constructor(
    public store: Store<RootState, Actions>,
    public props: TreeProps<T>,
    public list: MutableRefObject<FixedSizeList | null>,
    public listEl: MutableRefObject<HTMLDivElement | null>,
  ) {
    /* Changes here must also be made in update() */
    this.root = createRoot<T>(this);
    this.visibleNodes = createList<T>(this);
    this.idToIndex = createIndex(this.visibleNodes);
  }

  /* Changes here must also be made in constructor() */
  update(props: TreeProps<T>) {
    this.props = props;
    this.root = createRoot<T>(this);
    this.visibleNodes = createList<T>(this);
    this.idToIndex = createIndex(this.visibleNodes);
  }

  /* Store helpers */

  dispatch(action: Actions) {
    return this.store.dispatch(action);
  }

  get state() {
    return this.store.getState();
  }

  get openState() {
    return this.state.nodes.open.unfiltered;
  }

  /* Tree Props */

  get width() {
    return this.props.width ?? 300;
  }

  get height() {
    return this.props.height ?? 500;
  }

  get indent() {
    return this.props.indent ?? 24;
  }

  get rowHeight() {
    return this.props.rowHeight ?? 24;
  }

  get overscanCount() {
    return this.props.overscanCount ?? 1;
  }

  get searchTerm() {
    return (this.props.searchTerm || "").trim();
  }

  get matchFn() {
    const match =
      this.props.searchMatch ??
      ((node, term) => {
        const string = JSON.stringify(
          Object.values(node.data as { [k: string]: unknown }),
        );
        return string.toLocaleLowerCase().includes(term.toLocaleLowerCase());
      });
    return (node: NodeApi<T>) => match(node, this.searchTerm);
  }

  accessChildren(data: T) {
    const get = this.props.childrenAccessor || "children";
    return utils.access<readonly T[] | undefined>(data, get) ?? null;
  }

  accessId(data: T) {
    const get = this.props.idAccessor || "id";
    const id = utils.access<string>(data, get);
    if (!id)
      throw new Error(
        "Data must contain an 'id' property or props.idAccessor must return a string",
      );
    return id;
  }

  /* Node Access */

  get firstNode() {
    return this.visibleNodes[0] ?? null;
  }

  get lastNode() {
    return this.visibleNodes[this.visibleNodes.length - 1] ?? null;
  }

  get focusedNode() {
    return this.get(this.state.nodes.focus.id) ?? null;
  }

  get mostRecentNode() {
    return this.get(this.state.nodes.selection.mostRecent) ?? null;
  }

  get nextNode() {
    const index = this.indexOf(this.focusedNode);
    if (index === null) return null;
    else return this.at(index + 1);
  }

  get prevNode() {
    const index = this.indexOf(this.focusedNode);
    if (index === null) return null;
    else return this.at(index - 1);
  }

  get(id: string | null): NodeApi<T> | null {
    if (!id) return null;
    if (id in this.idToIndex)
      return this.visibleNodes[this.idToIndex[id]] || null;
    else return null;
  }

  at(index: number): NodeApi<T> | null {
    return this.visibleNodes[index] || null;
  }

  nodesBetween(startId: string | null, endId: string | null) {
    if (startId === null || endId === null) return [];
    const index1 = this.indexOf(startId) ?? 0;
    const index2 = this.indexOf(endId);
    if (index2 === null) return [];
    const start = Math.min(index1, index2);
    const end = Math.max(index1, index2);
    return this.visibleNodes.slice(start, end + 1);
  }

  indexOf(id: string | null | IdObj) {
    const key = utils.identifyNull(id);
    if (!key) return null;
    return this.idToIndex[key];
  }

  /* Data Operations */

  get editingId() {
    return this.state.nodes.edit.id;
  }

  createInternal() {
    return this.create({ type: "internal" });
  }

  createLeaf() {
    return this.create({ type: "leaf" });
  }

  async create(
    opts: {
      type?: "internal" | "leaf";
      parentId?: null | string;
      index?: null | number;
    } = {},
  ) {
    const parentId =
      opts.parentId === undefined
        ? utils.getInsertParentId(this)
        : opts.parentId;
    const index = opts.index ?? utils.getInsertIndex(this);
    const type = opts.type ?? "leaf";
    const data = await safeRun(this.props.onCreate, {
      type,
      parentId,
      index,
      parentNode: this.get(parentId),
    });
    if (data) {
      this.focus(data);
      setTimeout(() => {
        this.edit(data).then(() => {
          this.select(data);
          this.activate(data);
        });
      });
    }
  }

  async delete(node: string | IdObj | null | string[] | IdObj[]) {
    if (!node) return;
    const idents = Array.isArray(node) ? node : [node];
    const ids = idents.map(identify);
    const nodes = ids.map((id) => this.get(id)!).filter((n) => !!n);
    await safeRun(this.props.onDelete, { nodes, ids });
  }

  edit(node: string | IdObj): Promise<EditResult> {
    const id = identify(node);
    this.resolveEdit({ cancelled: true });
    this.scrollTo(id);
    this.dispatch(edit(id));
    return new Promise((resolve) => {
      TreeApi.editPromise = resolve;
    });
  }

  async submit(identity: Identity, value: string) {
    if (!identity) return;
    const id = identify(identity);
    await safeRun(this.props.onRename, {
      id,
      name: value,
      node: this.get(id)!,
    });
    this.dispatch(edit(null));
    this.resolveEdit({ cancelled: false, value });
    setTimeout(() => this.onFocus()); // Return focus to element;
  }

  reset() {
    this.dispatch(edit(null));
    this.resolveEdit({ cancelled: true });
    setTimeout(() => this.onFocus()); // Return focus to element;
  }

  activate(id: string | IdObj | null) {
    const node = this.get(identifyNull(id));
    if (!node) return;
    safeRun(this.props.onActivate, node);
  }

  private resolveEdit(value: EditResult) {
    const resolve = TreeApi.editPromise;
    if (resolve) resolve(value);
    TreeApi.editPromise = null;
  }

  /* Focus and Selection */

  get selectedIds() {
    return this.state.nodes.selection.ids;
  }

  get selectedNodes() {
    let nodes = [];
    for (let id of Array.from(this.selectedIds)) {
      const node = this.get(id);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  focus(node: Identity, opts: { scroll?: boolean } = {}) {
    if (!node) return;
    /* Focus is responsible for scrolling, while selection is
     * responsible for focus. If selectionFollowsFocus, then
     * just select it. */
    if (this.props.selectionFollowsFocus) {
      this.select(node);
    } else {
      this.dispatch(focus(identify(node)));
      if (opts.scroll !== false) this.scrollTo(node);
      if (this.focusedNode) safeRun(this.props.onFocus, this.focusedNode);
    }
  }

  pageUp() {
    const start = this.visibleStartIndex;
    const stop = this.visibleStopIndex;
    const page = stop - start;
    let index = this.focusedNode?.rowIndex ?? 0;
    if (index > start) {
      index = start;
    } else {
      index = Math.max(start - page, 0);
    }
    this.focus(this.at(index));
  }

  pageDown() {
    const start = this.visibleStartIndex;
    const stop = this.visibleStopIndex;
    const page = stop - start;
    let index = this.focusedNode?.rowIndex ?? 0;
    if (index < stop) {
      index = stop;
    } else {
      index = Math.min(index + page, this.visibleNodes.length - 1);
    }
    this.focus(this.at(index));
  }

  select(node: Identity, opts: { align?: Align; focus?: boolean } = {}) {
    if (!node) return;
    const changeFocus = opts.focus !== false;
    const id = identify(node);
    if (changeFocus) this.dispatch(focus(id));
    this.dispatch(selection.only(id));
    this.dispatch(selection.anchor(id));
    this.dispatch(selection.mostRecent(id));
    this.scrollTo(id, opts.align);
    if (this.focusedNode && changeFocus) {
      safeRun(this.props.onFocus, this.focusedNode);
    }
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  deselect(node: Identity) {
    if (!node) return;
    const id = identify(node);
    this.dispatch(selection.remove(id));
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  selectMulti(identity: Identity) {
    const node = this.get(identifyNull(identity));
    if (!node) return;
    this.dispatch(focus(node.id));
    this.dispatch(selection.add(node.id));
    this.dispatch(selection.anchor(node.id));
    this.dispatch(selection.mostRecent(node.id));
    this.scrollTo(node);
    if (this.focusedNode) safeRun(this.props.onFocus, this.focusedNode);
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  selectBatch(ids: string[]) {
    if (!Array.isArray(ids)) return;
    if (ids.length === 0) {
      this.deselectAll();
      return;
    }
    const focusId = ids[0];
    if (!focusId) return;
    const node = this.get(identifyNull(focusId));
    if (!node) return;
    this.dispatch(selection.clear());
    this.dispatch(focus(node.id));
    this.dispatch(selection.add(ids));
    this.dispatch(selection.anchor(node.id));
    this.dispatch(selection.mostRecent(node.id));
    this.scrollTo(node);
    if (this.focusedNode) safeRun(this.props.onFocus, this.focusedNode);
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  selectContiguous(identity: Identity) {
    if (!identity) return;
    const id = identify(identity);
    const { anchor, mostRecent } = this.state.nodes.selection;
    this.dispatch(focus(id));
    this.dispatch(selection.remove(this.nodesBetween(anchor, mostRecent)));
    this.dispatch(selection.add(this.nodesBetween(anchor, identifyNull(id))));
    this.dispatch(selection.mostRecent(id));
    this.scrollTo(id);
    if (this.focusedNode) safeRun(this.props.onFocus, this.focusedNode);
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  deselectAll() {
    this.setSelection({ ids: [], anchor: null, mostRecent: null });
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  selectAll() {
    this.setSelection({
      ids: Object.keys(this.idToIndex),
      anchor: this.firstNode,
      mostRecent: this.lastNode,
    });
    this.dispatch(focus(this.lastNode?.id));
    if (this.focusedNode) safeRun(this.props.onFocus, this.focusedNode);
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  setSelection(args: {
    ids: (IdObj | string)[] | null;
    anchor: IdObj | string | null;
    mostRecent: IdObj | string | null;
  }) {
    const ids = new Set(args.ids?.map(identify));
    const anchor = identifyNull(args.anchor);
    const mostRecent = identifyNull(args.mostRecent);
    this.dispatch(selection.set({ ids, anchor, mostRecent }));
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  /* Checked State */

  get isCheckable() {
    return this.props.checkable === true;
  }

  get checkedIds() {
    return this.getCheckedState().checkedIds;
  }

  get checkedNodes() {
    const nodes: NodeApi<T>[] = [];
    utils.walk(this.root, (node) => {
      if (!node.isRoot && this.checkedIds.has(node.id)) nodes.push(node);
    });
    return nodes;
  }

  get halfCheckedIds() {
    return this.getCheckedState().halfCheckedIds;
  }

  get halfCheckedNodes() {
    const halfCheckedIds = this.halfCheckedIds;
    const nodes: NodeApi<T>[] = [];
    utils.walk(this.root, (node) => {
      if (!node.isRoot && halfCheckedIds.has(node.id)) nodes.push(node);
    });
    return nodes;
  }

  get hasNoChecked() {
    return this.checkedIds.size === 0;
  }

  get hasOneChecked() {
    return this.checkedIds.size === 1;
  }

  get hasMultipleChecked() {
    return this.checkedIds.size > 1;
  }

  check(identity: Identity) {
    if (!this.isCheckable) return;
    const id = identifyNull(identity);
    if (!id || id === ROOT_ID || this.isChecked(id)) return;
    if (this.props.checkStrictly) {
      this.dispatch(checked.add(id));
    } else {
      const ids = new Set(this.checkedIds);
      this.addSubtreeIds(ids, id);
      this.dispatch(checked.set(this.normalizeCheckedIds(ids)));
    }
    safeRun(this.props.onCheck, this.checkedNodes);
  }

  uncheck(identity: Identity) {
    if (!this.isCheckable) return;
    const id = identifyNull(identity);
    if (!id) return;
    if (this.props.checkStrictly) {
      if (!this.isChecked(id)) return;
      this.dispatch(checked.remove(id));
    } else {
      if (!this.isChecked(id) && !this.isHalfChecked(id)) return;
      const ids = new Set(this.checkedIds);
      this.removeSubtreeIds(ids, id);
      this.removeAncestorIds(ids, id);
      this.dispatch(checked.set(this.normalizeCheckedIds(ids)));
    }
    safeRun(this.props.onCheck, this.checkedNodes);
  }

  toggleCheck(identity: Identity) {
    if (!this.isCheckable) return;
    const id = identifyNull(identity);
    if (!id) return;
    return this.isChecked(id) ? this.uncheck(id) : this.check(id);
  }

  checkBatch(identities: readonly Identity[]) {
    if (!this.isCheckable) return;
    const ids = this.identifyIds(identities);
    if (ids.length === 0) return;
    if (this.props.checkStrictly) {
      const uncheckedIds = ids.filter((id) => !this.isChecked(id));
      if (uncheckedIds.length === 0) return;
      this.dispatch(checked.add(uncheckedIds));
    } else {
      const nextIds = new Set(this.checkedIds);
      ids.forEach((id) => this.addSubtreeIds(nextIds, id));
      this.dispatch(checked.set(this.normalizeCheckedIds(nextIds)));
    }
    safeRun(this.props.onCheck, this.checkedNodes);
  }

  uncheckBatch(identities: readonly Identity[]) {
    if (!this.isCheckable) return;
    const ids = this.identifyIds(identities);
    if (ids.length === 0) return;
    if (this.props.checkStrictly) {
      const checkedIds = ids.filter((id) => this.isChecked(id));
      if (checkedIds.length === 0) return;
      this.dispatch(checked.remove(checkedIds));
    } else {
      const nextIds = new Set(this.checkedIds);
      ids.forEach((id) => {
        this.removeSubtreeIds(nextIds, id);
        this.removeAncestorIds(nextIds, id);
      });
      this.dispatch(checked.set(this.normalizeCheckedIds(nextIds)));
    }
    safeRun(this.props.onCheck, this.checkedNodes);
  }

  setChecked(identities: readonly Identity[], opts: { notify?: boolean } = {}) {
    if (!this.isCheckable) return;
    const ids = this.normalizeCheckedIds(new Set(this.identifyIds(identities)));
    this.dispatch(checked.set(ids));
    if (opts.notify !== false) safeRun(this.props.onCheck, this.checkedNodes);
  }

  uncheckAll() {
    if (!this.isCheckable) return;
    if (this.hasNoChecked) return;
    this.dispatch(checked.clear());
    safeRun(this.props.onCheck, this.checkedNodes);
  }

  checkAll() {
    if (!this.isCheckable) return;
    const ids = this.allNodeIds();
    this.setChecked(ids);
  }

  isChecked(id?: string) {
    if (!this.isCheckable) return false;
    if (!id) return false;
    return this.checkedIds.has(id);
  }

  isHalfChecked(id?: string) {
    if (!this.isCheckable) return false;
    if (!id) return false;
    return this.halfCheckedIds.has(id);
  }

  /* Drag and Drop */

  get cursorParentId() {
    const { cursor } = this.state.dnd;
    switch (cursor.type) {
      case "highlight":
        return cursor.id;
      default:
        return null;
    }
  }

  get cursorOverFolder() {
    return this.state.dnd.cursor.type === "highlight";
  }

  get dragNodes() {
    return this.state.dnd.dragIds
      .map((id) => this.get(id))
      .filter((n) => !!n) as NodeApi<T>[];
  }

  get dragNode() {
    return this.get(this.state.nodes.drag.id);
  }

  get dragDestinationParent() {
    return this.get(this.state.nodes.drag.destinationParentId);
  }

  get dragDestinationIndex() {
    return this.state.nodes.drag.destinationIndex;
  }

  canDrop() {
    if (this.isFiltered) return false;
    const parentNode = this.get(this.state.dnd.parentId) ?? this.root;
    const dragNodes = this.dragNodes;
    const isDisabled = this.props.disableDrop;

    for (const drag of dragNodes) {
      if (!drag) return false;
      if (!parentNode) return false;
      if (drag.isInternal && utils.isDescendant(parentNode, drag)) return false;
    }

    // Allow the user to insert their own logic
    if (typeof isDisabled == "function") {
      return !isDisabled({
        parentNode,
        dragNodes: this.dragNodes,
        index: this.state.dnd.index || 0,
      });
    } else if (typeof isDisabled == "string") {
      // @ts-ignore
      return !parentNode.data[isDisabled];
    } else if (typeof isDisabled === "boolean") {
      return !isDisabled;
    } else {
      return true;
    }
  }

  hideCursor() {
    this.dispatch(dnd.cursor({ type: "none" }));
  }

  showCursor(cursor: Cursor) {
    this.dispatch(dnd.cursor(cursor));
  }

  /* Visibility */

  batchSetOpen(identities: Identity[], isOpen: boolean) {
    const ids = identities
      .map(utils.identifyNull)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return;
    this.dispatch(visibility.batchUpdate(ids, isOpen, this.isFiltered));
  }

  openAllUnder(identity: Identity) {
    const id = utils.identifyNull(identity);
    if (!id) return;

    const node = this.get(id);
    if (!node || node.isLeaf) return;

    const allIds: string[] = [];
    utils.walk(node, (n) => {
      if (n.isInternal) allIds.push(n.id);
    });

    this.batchSetOpen(
      allIds.map((id) => id),
      true,
    );
  }

  closeAllUnder(identity: Identity) {
    const id = utils.identifyNull(identity);
    if (!id) return;

    const node = this.get(id);
    if (!node || node.isLeaf) return;

    const allIds: string[] = [];
    utils.walk(node, (n) => {
      if (n.isInternal) allIds.push(n.id);
    });

    this.batchSetOpen(
      allIds.map((id) => id),
      false,
    );
  }

  open(identity: Identity) {
    const id = identifyNull(identity);
    if (!id) return;
    if (this.isOpen(id)) return;
    this.dispatch(visibility.open(id, this.isFiltered));
    safeRun(this.props.onToggle, id);
  }

  close(identity: Identity) {
    const id = identifyNull(identity);
    if (!id) return;
    if (!this.isOpen(id)) return;
    this.dispatch(visibility.close(id, this.isFiltered));
    safeRun(this.props.onToggle, id);
  }

  toggle(identity: Identity) {
    const id = identifyNull(identity);
    if (!id) return;
    return this.isOpen(id) ? this.close(id) : this.open(id);
  }

  openParents(identity: Identity) {
    const id = identifyNull(identity);
    if (!id) return;
    const node = utils.dfs(this.root, id);
    let parent = node?.parent;

    while (parent) {
      this.open(parent.id);
      parent = parent.parent;
    }
  }

  openSiblings(node: NodeApi<T>) {
    const parent = node.parent;
    if (!parent) {
      this.toggle(node.id);
    } else if (parent.children) {
      const isOpen = node.isOpen;
      for (let sibling of parent.children) {
        if (sibling.isInternal) {
          isOpen ? this.close(sibling.id) : this.open(sibling.id);
        }
      }
      this.scrollTo(this.focusedNode);
    }
  }

  openAll() {
    const ids = this.allInternalNodeIds().filter((id) => !this.isOpen(id));
    this.batchSetOpen(ids, true);
    ids.forEach((id) => safeRun(this.props.onToggle, id));
  }

  closeAll() {
    const ids = this.allInternalNodeIds().filter((id) => this.isOpen(id));
    this.batchSetOpen(ids, false);
    ids.forEach((id) => safeRun(this.props.onToggle, id));
  }

  /* Scrolling */

  scrollTo(identity: Identity, align: Align = "smart") {
    if (!identity) return;
    const id = identify(identity);
    this.openParents(id);
    return utils
      .waitFor(() => id in this.idToIndex)
      .then(() => {
        const index = this.idToIndex[id];
        if (index === undefined) return;
        let basePosition;
        const containerHeight = this.props.height ?? 0;
        const itemSize = this.props.rowHeight ?? 0;
        // 合并 padding 相关的计算
        const verticalPadding =
          (this.props.padding ?? 0) * 2 ||
          (this.props.paddingBottom ?? 0) + (this.props.paddingTop ?? 0);
        const itemCount = this.visibleNodes?.length ?? 0;
        switch (align) {
          case "start":
            basePosition = index * itemSize;
            break;
          case "end":
            basePosition = index * itemSize + itemSize - containerHeight;
            break;
          case "center":
            basePosition =
              index * itemSize + itemSize / 2 - containerHeight / 2;
            break;
          // smart/auto
          default:
            // @ts-ignore 忽略state.scrollOffset的类型检查
            const currentScrollTop = this.list.current?.state.scrollOffset ?? 0;
            // 计算节点的位置
            const nodePosition = index * itemSize;
            // 判断节点是否在可视区域内
            const isVisible =
              nodePosition >= currentScrollTop - itemSize - verticalPadding &&
              nodePosition <=
                currentScrollTop + containerHeight + verticalPadding + itemSize;
            // 如果节点不在可视区域内,才进行滚动
            if (!isVisible) {
              basePosition =
                index * itemSize + itemSize / 2 - containerHeight / 2;
            }
            break;
        }
        let targetPosition = basePosition;
        if (targetPosition) {
          const maxScrollTop =
            itemCount * itemSize - containerHeight + verticalPadding; // 最大可滚动位置，考虑padding
          targetPosition = Math.max(0, Math.min(targetPosition, maxScrollTop));
          this.list.current?.scrollTo(targetPosition);
        }
      })
      .catch(() => {
        // Id: ${id} never appeared in the list.
      });
  }

  /* State Checks */

  get isEditing() {
    return this.state.nodes.edit.id !== null;
  }

  get isFiltered() {
    return !!this.props.searchTerm?.trim();
  }

  get hasFocus() {
    return this.state.nodes.focus.treeFocused;
  }

  get hasNoSelection() {
    return this.state.nodes.selection.ids.size === 0;
  }

  get hasOneSelection() {
    return this.state.nodes.selection.ids.size === 1;
  }

  get hasMultipleSelections() {
    return this.state.nodes.selection.ids.size > 1;
  }

  isSelected(id?: string) {
    if (!id) return false;
    return this.state.nodes.selection.ids.has(id);
  }

  isOpen(id?: string) {
    if (!id) return false;
    if (id === ROOT_ID) return true;
    const def = this.props.openByDefault ?? true;
    if (this.isFiltered) {
      return this.state.nodes.open.filtered[id] ?? true; // Filtered folders are always opened by default
    } else {
      return this.state.nodes.open.unfiltered[id] ?? def;
    }
  }

  isEditable(data: T) {
    const check = this.props.disableEdit || (() => false);
    return !utils.access(data, check);
  }

  isDraggable(data: T) {
    const check = this.props.disableDrag || (() => false);
    return !utils.access(data, check);
  }

  isDragging(node: string | IdObj | null) {
    const id = identifyNull(node);
    if (!id) return false;
    return this.state.nodes.drag.id === id;
  }

  isFocused(id: string) {
    return this.hasFocus && this.state.nodes.focus.id === id;
  }

  isMatch(node: NodeApi<T>) {
    return this.matchFn(node);
  }

  willReceiveDrop(node: string | IdObj | null) {
    const id = identifyNull(node);
    if (!id) return false;
    const { destinationParentId, destinationIndex } = this.state.nodes.drag;
    return id === destinationParentId && destinationIndex === null;
  }

  private identifyIds(identities: readonly Identity[]) {
    return identities
      .map(identifyNull)
      .filter((id): id is string => !!id && id !== ROOT_ID);
  }

  private allNodeIds() {
    const ids: string[] = [];
    utils.walk(this.root, (node) => {
      if (!node.isRoot) ids.push(node.id);
    });
    return ids;
  }

  private allInternalNodeIds() {
    const ids: string[] = [];
    utils.walk(this.root, (node) => {
      if (!node.isRoot && node.isInternal) ids.push(node.id);
    });
    return ids;
  }

  private findNode(id: string) {
    return utils.dfs(this.root, id);
  }

  // Collect the node and every descendant id in tree order.
  private collectSubtreeIds(node: NodeApi<T>) {
    const ids: string[] = [];
    utils.walk(node, (n) => {
      if (!n.isRoot) ids.push(n.id);
    });
    return ids;
  }

  // Add the target node and every descendant to a candidate checked set.
  private addSubtreeIds(ids: Set<string>, id: string) {
    const node = this.findNode(id);
    if (!node || node.isRoot) return;
    this.collectSubtreeIds(node).forEach((nodeId) => ids.add(nodeId));
  }

  // Remove the target node and every descendant from a candidate checked set.
  private removeSubtreeIds(ids: Set<string>, id: string) {
    const node = this.findNode(id);
    if (!node) return;
    this.collectSubtreeIds(node).forEach((nodeId) => ids.delete(nodeId));
  }

  // Remove ancestors so a later conduct pass can recompute them from children.
  private removeAncestorIds(ids: Set<string>, id: string) {
    let parent = this.findNode(id)?.parent;
    while (parent && !parent.isRoot) {
      ids.delete(parent.id);
      parent = parent.parent;
    }
  }

  private getCheckedState() {
    if (!this.isCheckable) {
      return { checkedIds: EMPTY_IDS, halfCheckedIds: EMPTY_IDS };
    }

    const sourceIds = this.state.nodes.checked.ids;
    const checkStrictly = this.props.checkStrictly === true;

    // If the source checked ids and checkStrictly mode are unchanged since the last call, return the cached checked state. This is an important optimization
    // because computing checked state can be expensive in large trees, and this
    // method is called frequently during render.
    if (
      this.checkedStateCache?.root === this.root &&
      this.checkedStateCache.sourceIds === sourceIds &&
      this.checkedStateCache.checkStrictly === checkStrictly
    ) {
      return this.checkedStateCache;
    }

    const checkedIds = this.normalizeCheckedIds(new Set(sourceIds));
    const halfCheckedIds = this.getHalfCheckedIds(checkedIds);
    this.checkedStateCache = {
      root: this.root,
      sourceIds,
      checkStrictly,
      checkedIds,
      halfCheckedIds,
    };
    return this.checkedStateCache;
  }

  // Conduct checked ids into the canonical linked-tree checked state.
  private normalizeCheckedIds(ids: Set<string>) {
    if (this.props.checkStrictly) return ids;

    // In linked mode, a checked internal node means its entire subtree is
    // checked. Expand any parent ids into descendant ids before recomputing
    // ancestor state.
    utils.walk(this.root, (node) => {
      if (!node.isRoot && ids.has(node.id)) {
        this.collectSubtreeIds(node).forEach((nodeId) => ids.add(nodeId));
      }
    });

    // Walk bottom-up so each parent is derived from final child state. A parent
    // is checked only when every direct child is checked.
    const visit = (node: NodeApi<T>) => {
      node.children?.forEach(visit);
      if (node.isRoot || node.isLeaf || !node.children?.length) return;

      const allChildrenChecked = node.children.every((child) =>
        ids.has(child.id),
      );
      if (allChildrenChecked) ids.add(node.id);
      else ids.delete(node.id);
    };
    visit(this.root);

    // Return ids in tree order instead of insertion order. This keeps public
    // checkedIds stable across batch operations and normalization passes.
    const orderedIds = new Set<string>();
    utils.walk(this.root, (node) => {
      if (!node.isRoot && ids.has(node.id)) orderedIds.add(node.id);
    });
    return orderedIds;
  }

  private getHalfCheckedIds(checkedIds: Set<string>) {
    if (this.props.checkStrictly) return new Set<string>();

    const ids = new Set<string>();
    const descendantCheckedIds = new Set<string>();

    // First pass: mark every node whose subtree contains at least one checked
    // node. This pass intentionally does not decide half-checked yet.
    const visit = (node: NodeApi<T>): boolean => {
      const selfChecked = checkedIds.has(node.id);
      let descendantChecked = false;

      node.children?.forEach((child) => {
        if (visit(child)) descendantChecked = true;
      });

      if (descendantChecked) descendantCheckedIds.add(node.id);

      return selfChecked || descendantChecked;
    };

    visit(this.root);

    // Second pass: a node is half-checked when it is internal, is not itself
    // checked, and has at least one checked descendant. The walk preserves tree
    // order for the public Set.
    utils.walk(this.root, (node) => {
      if (
        !node.isRoot &&
        node.isInternal &&
        !checkedIds.has(node.id) &&
        descendantCheckedIds.has(node.id)
      ) {
        ids.add(node.id);
      }
    });
    return ids;
  }

  /* Tree Event Handlers */

  onFocus() {
    const node = this.focusedNode || this.firstNode;
    if (node) this.dispatch(focus(node.id));
  }

  onBlur() {
    this.dispatch(treeBlur());
  }

  onItemsRendered(args: ListOnItemsRenderedProps) {
    this.visibleStartIndex = args.visibleStartIndex;
    this.visibleStopIndex = args.visibleStopIndex;
  }

  /* Get Renderers */

  get renderContainer() {
    return this.props.renderContainer || DefaultContainer;
  }

  get renderRow() {
    return this.props.renderRow || DefaultRow;
  }

  get renderNode() {
    return this.props.children || DefaultNode;
  }

  get renderDragPreview() {
    return this.props.renderDragPreview || DefaultDragPreview;
  }

  get renderCursor() {
    return this.props.renderCursor || DefaultCursor;
  }
}
