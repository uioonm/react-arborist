import { EditResult } from "../types/handlers";
import { BoolFunc, Identity, IdObj } from "../types/utils";
import { TreeProps } from "../types/tree-props";
import { MutableRefObject } from "react";
import {
  Align,
  FixedSizeList,
  ListOnItemsRenderedProps,
  VariableSizeList,
} from "react-window";
import * as utils from "../utils";
import { DefaultCursor } from "../components/default-cursor";
import { DefaultRow } from "../components/default-row";
import { DefaultNode } from "../components/default-node";
import { NodeApi } from "./node-api";
import { edit } from "../state/edit-slice";
import { Actions, RootState } from "../state/root-reducer";
import { focus, treeBlur } from "../state/focus-slice";
import { createRoot, ROOT_ID } from "../data/create-root";
import { actions as visibility, OpenMap } from "../state/open-slice";
import { actions as selection } from "../state/selection-slice";
import { actions as checked } from "../state/checked-slice";
import { actions as loading } from "../state/loading-slice";
import { actions as dnd } from "../state/dnd-slice";
import { DefaultDragPreview } from "../components/default-drag-preview";
import { DefaultContainer } from "../components/default-container";
import { Cursor } from "../dnd/compute-drop";
import { Store } from "redux";
import { createList } from "../data/create-list";
import { createIndex } from "../data/create-index";

const { safeRun, identifyNull } = utils;
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
    sourceHalfCheckedIds: readonly string[] | undefined;
    checkStrictly: boolean;
    checkedIds: Set<string>;
    halfCheckedIds: Set<string>;
  } | null = null;
  /* Memoized prefix-sum of row heights; only used for variable heights. */
  private rowOffsets: number[] | null = null;

  constructor(
    public store: Store<RootState, Actions>,
    public props: TreeProps<T>,
    public list: MutableRefObject<FixedSizeList | VariableSizeList | null>,
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
    this.rowOffsets = null;
    /* Variable-height mode renders a VariableSizeList, which caches item
       measurements by index and never invalidates them on its own. When the
       visible nodes change (insert/remove/reorder), those cached sizes belong
       to the wrong rows, so drop them. Fixed-height mode renders a
       FixedSizeList (no cache, nothing to reset). update() runs during render,
       so pass shouldForceUpdate=false: the in-progress render repaints the list
       and a forceUpdate here would warn about setting state mid-render. */
    const list = this.list.current;
    if (list && "resetAfterIndex" in list) {
      list.resetAfterIndex(0, false);
    }
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

  /**
   * The fixed row height. When a `rowHeight` function is supplied for variable
   * heights, this returns the default (24); use `rowHeightAt(index)` to get the
   * height of a specific row.
   */
  get rowHeight() {
    return typeof this.props.rowHeight === "number" ? this.props.rowHeight : 24;
  }

  /**
   * The height of the row at `index`, evaluating the `rowHeight` function if
   * given. Falls back to the default height for an out-of-range index so this
   * never feeds an invalid `0` to react-window's `itemSize`.
   */
  rowHeightAt = (index: number): number => {
    const rowHeight = this.props.rowHeight;
    if (typeof rowHeight === "function") {
      const node = this.at(index);
      return node ? rowHeight(node) : this.rowHeight;
    }
    return rowHeight ?? 24;
  };

  /** The pixel offset of the top of the row at `index` from the top of the list. */
  rowTopPosition = (index: number): number => {
    /* Fixed heights: O(1). */
    if (typeof this.props.rowHeight !== "function") {
      return index * this.rowHeight;
    }
    /* Variable heights: O(1) amortized via a memoized prefix sum. */
    const offsets = this.getRowOffsets();
    const clamped = Math.max(0, Math.min(index, offsets.length - 1));
    return offsets[clamped];
  };

  /**
   * Tell the underlying virtualized list to recompute row heights at and after
   * `index`. Call this if a `rowHeight` function's output changes for reasons
   * the tree can't observe (e.g. external state).
   */
  redrawList = (afterIndex: number = 0) => {
    this.rowOffsets = null;
    /* Only the VariableSizeList (function rowHeight) caches measurements; a
       FixedSizeList has constant heights and nothing to recompute. */
    const list = this.list.current;
    if (list && "resetAfterIndex" in list) {
      list.resetAfterIndex(Math.max(0, afterIndex));
    }
  };

  /** Lazily-built prefix sum where offsets[i] is the top of row i. */
  private getRowOffsets(): number[] {
    if (this.rowOffsets) return this.rowOffsets;
    const offsets: number[] = [0];
    for (let i = 0; i < this.visibleNodes.length; i++) {
      offsets.push(offsets[i] + this.rowHeightAt(i));
    }
    this.rowOffsets = offsets;
    return offsets;
  }

  get overscanCount() {
    return this.props.overscanCount ?? 1;
  }

  get searchTerm() {
    const term = this.props.searchTerm;
    return typeof term === "string" ? term.trim() : term;
  }

  get matchFn() {
    const match =
      this.props.searchMatch ??
      ((node, term) => {
        const string = JSON.stringify(
          // @ts-ignore
          Object.values(node.data as { [k: string]: unknown }),
        );
        return string
          .toLocaleLowerCase()
          .includes(String(term).toLocaleLowerCase());
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

  /**
   * Resolve an identifier to a node id. Public methods accept an id string, a
   * NodeApi, or the raw row data; this is the one place that turns any of those
   * into the string id used internally. Raw data is run through the configured
   * `idAccessor` so a custom accessor (e.g. `uuid`) is honored everywhere, not
   * just where nodes were built. A NodeApi already carries its accessor-derived
   * `id`, so it is used directly rather than re-accessed (the accessor reads the
   * underlying data, which a NodeApi does not expose under that key). Unlike
   * `accessId`, an unresolved id comes back as `undefined` rather than throwing,
   * preserving the previous behavior of the `id`-only lookup.
   */
  identify(identity: string | IdObj | T): string {
    if (typeof identity === "string") return identity;
    if (identity instanceof NodeApi) return identity.id;
    const get = this.props.idAccessor || "id";
    return utils.access<string>(identity, get);
  }

  identifyNull(identity: Identity | T): string | null {
    if (identity === null || identity === undefined) return null;
    return this.identify(identity);
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

  indexOf(id: Identity | T) {
    const key = this.identifyNull(id);
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

  async delete(node: Identity | T | (string | IdObj | T)[]) {
    if (!node) return;
    const idents = Array.isArray(node) ? node : [node];
    const ids = idents.map((i) => this.identify(i));
    const nodes = ids.map((id) => this.get(id)!).filter((n) => !!n);
    /* Guard against Math.min(...[]) === Infinity when no ids resolve to nodes. */
    const fromIndex = nodes.length
      ? Math.min(...nodes.map((n) => n.rowIndex ?? 0))
      : 0;
    await safeRun(this.props.onDelete, { nodes, ids });
    this.redrawList(fromIndex);
  }

  async loadData(identity: Identity | T) {
    if (!this.props.loadData) return;
    const id = this.identifyNull(identity);
    if (!id || id === ROOT_ID || this.isLoading(id)) return;
    const node = this.findNode(id);
    if (!node) return;
    const fromIndex = node.rowIndex ?? 0;

    this.dispatch(loading.add(id));
    try {
      await this.props.loadData(node);
      this.update(this.props);
      this.redrawList(fromIndex);
    } finally {
      this.dispatch(loading.remove(id));
    }
  }

  edit(node: string | IdObj | T): Promise<EditResult> {
    const id = this.identify(node);
    this.resolveEdit({ cancelled: true });
    this.scrollTo(id);
    this.dispatch(edit(id));
    this.redrawList(this.get(id)?.rowIndex ?? 0);
    return new Promise((resolve) => {
      TreeApi.editPromise = resolve;
    });
  }

  async submit(identity: Identity | T, value: string) {
    if (!identity) return;
    const id = this.identify(identity);
    await safeRun(this.props.onRename, {
      id,
      name: value,
      node: this.get(id)!,
    });
    this.dispatch(edit(null));
    this.resolveEdit({ cancelled: false, value });
    this.redrawList(this.get(id)?.rowIndex ?? 0);
    setTimeout(() => this.onFocus()); // Return focus to element;
  }

  reset() {
    this.dispatch(edit(null));
    this.resolveEdit({ cancelled: true });
    this.redrawList();
    setTimeout(() => this.onFocus()); // Return focus to element;
  }

  activate(id: Identity | T) {
    const node = this.get(this.identifyNull(id));
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

  focus(node: Identity | T, opts: { scroll?: boolean } = {}) {
    if (!node) return;
    /* Focus is responsible for scrolling, while selection is
     * responsible for focus. If selectionFollowsFocus, then
     * just select it. */
    if (this.props.selectionFollowsFocus) {
      this.select(node);
    } else {
      this.dispatch(focus(this.identify(node)));
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

  select(node: Identity | T, opts: { align?: Align; focus?: boolean } = {}) {
    if (!node) return;
    const changeFocus = opts.focus !== false;
    const id = this.identify(node);
    if (changeFocus) this.dispatch(focus(id));
    if (this.get(id)?.isSelectable) {
      this.setSelection({
        ids: [id],
        anchor: id,
        mostRecent: id,
      });
    }
    this.scrollTo(id, opts.align);
    if (this.focusedNode && changeFocus) {
      safeRun(this.props.onFocus, this.focusedNode);
    }
  }

  deselect(node: Identity | T) {
    if (!node) return;
    const id = this.identify(node);
    this.dispatch(selection.remove(id));
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  selectMulti(
    identity: Identity | T,
    opts: { align?: Align; focus?: boolean } = {},
  ) {
    const node = this.get(this.identifyNull(identity));
    if (!node) return;
    const changeFocus = opts.focus !== false;
    if (changeFocus) this.dispatch(focus(node.id));
    if (node.isSelectable) {
      this.dispatch(selection.add(node.id));
      this.dispatch(selection.anchor(node.id));
      this.dispatch(selection.mostRecent(node.id));
    }
    this.scrollTo(node, opts.align);
    if (this.focusedNode && changeFocus) {
      safeRun(this.props.onFocus, this.focusedNode);
    }
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

  selectContiguous(identity: Identity | T) {
    if (!identity) return;
    const id = this.identify(identity);
    this.dispatch(focus(id));
    if (this.get(id)?.isSelectable) {
      const { anchor, mostRecent } = this.state.nodes.selection;
      const selectableNodes = this.filterSelectableNodes(
        this.nodesBetween(anchor, this.identifyNull(id)),
      );
      this.dispatch(selection.remove(this.nodesBetween(anchor, mostRecent)));
      this.dispatch(selection.add(selectableNodes));
      this.dispatch(selection.mostRecent(id));
    }
    this.scrollTo(id);
    if (this.focusedNode) safeRun(this.props.onFocus, this.focusedNode);
    safeRun(this.props.onSelect, this.selectedNodes);
  }

  deselectAll() {
    // setSelection fires onSelect; don't fire it again here (see #332).
    this.setSelection({ ids: [], anchor: null, mostRecent: null });
  }

  selectAll() {
    const allSelectableNodes = this.filterSelectableNodes(
      Object.keys(this.idToIndex),
    );
    // setSelection fires onSelect; don't fire it again here (see #332).
    this.setSelection({
      ids: allSelectableNodes,
      anchor: allSelectableNodes[0] ?? null,
      mostRecent: allSelectableNodes[allSelectableNodes.length - 1] ?? null,
    });
    this.dispatch(focus(this.lastNode?.id));
    if (this.focusedNode) safeRun(this.props.onFocus, this.focusedNode);
  }

  private filterSelectableNodes(nodes: (IdObj | string)[]) {
    return nodes
      .map((n) => this.get(this.identify(n)))
      .filter((n): n is NodeApi<T> => !!n && n.isSelectable);
  }

  setSelection(args: {
    ids: (IdObj | string | T)[] | null;
    anchor: Identity | T;
    mostRecent: Identity | T;
  }) {
    const ids = new Set(args.ids?.map((i) => this.identify(i)));
    const anchor = this.identifyNull(args.anchor);
    const mostRecent = this.identifyNull(args.mostRecent);
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

  drop() {
    const { parentId, index, dragIds } = this.state.dnd;
    safeRun(this.props.onMove, {
      dragIds,
      parentId: parentId === ROOT_ID ? null : parentId,
      index: index === null ? 0 : index, // When it's null it was dropped over a folder
      dragNodes: this.dragNodes,
      parentNode: this.get(parentId),
    });
    this.open(parentId);
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

  setOpenIds(identities: readonly Identity[]) {
    const state: OpenMap = {};

    this.identifyIds(identities).forEach((id) => {
      state[id] = true;
    });

    this.dispatch(visibility.replace(state, this.isFiltered));
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

  open(identity: Identity | T, redraw: boolean = true) {
    const id = this.identifyNull(identity);
    if (!id) return;
    if (this.isOpen(id)) return;
    const node = this.findNode(id);
    this.dispatch(visibility.open(id, this.isFiltered));
    if (redraw) this.redrawList(this.get(id)?.rowIndex ?? 0);
    safeRun(this.props.onToggle, id);
    this.loadDataOnOpen(node);
  }

  close(identity: Identity | T, redraw: boolean = true) {
    const id = this.identifyNull(identity);
    if (!id) return;
    if (!this.isOpen(id)) return;
    this.dispatch(visibility.close(id, this.isFiltered));
    if (redraw) this.redrawList(this.get(id)?.rowIndex ?? 0);
    safeRun(this.props.onToggle, id);
  }

  toggle(identity: Identity | T) {
    const id = this.identifyNull(identity);
    if (!id) return;
    return this.isOpen(id) ? this.close(id) : this.open(id);
  }

  openParents(identity: Identity | T) {
    const id = this.identifyNull(identity);
    if (!id) return;
    const node = utils.dfs(this.root, id);
    let parent = node?.parent;

    while (parent) {
      this.open(parent.id, false);
      parent = parent.parent;
    }
    this.redrawList();
  }

  openSiblings(node: NodeApi<T>) {
    const parent = node.parent;
    if (!parent) {
      this.toggle(node.id);
    } else if (parent.children) {
      const isOpen = node.isOpen;
      for (let sibling of parent.children) {
        if (sibling.isInternal) {
          if (isOpen) this.close(sibling.id, false);
          else this.open(sibling.id, false);
        }
      }
      this.redrawList();
      this.scrollTo(this.focusedNode);
    }
  }

  openAll() {
    const ids = this.allInternalNodeIds().filter((id) => !this.isOpen(id));
    this.batchSetOpen(ids, true);
    ids.forEach((id) => safeRun(this.props.onToggle, id));
  }

  closeAll() {
    utils.walk(this.root, (node) => {
      if (node.isInternal) this.close(node.id, false);
    });
    this.redrawList();
  }

  /* Scrolling */

  scrollTo(identity: Identity | T, align: Align = "smart") {
    if (!identity) return;
    const id = this.identify(identity);
    this.openParents(id);
    return utils
      .waitFor(() => id in this.idToIndex)
      .then(() => {
        const index = this.idToIndex[id];
        if (index === undefined) return;
        this.list.current?.scrollToItem(index, align);
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
    return (
      this.searchTerm !== undefined &&
      this.searchTerm !== null &&
      this.searchTerm !== ""
    );
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
    return this.isActionPossible(data, this.props.disableEdit);
  }

  isDraggable(data: T) {
    return this.isActionPossible(data, this.props.disableDrag);
  }

  isSelectable(data: T) {
    return this.isActionPossible(data, this.props.disableSelect);
  }

  private isActionPossible(
    data: T,
    disabler: string | boolean | BoolFunc<T> = () => false,
  ) {
    return !utils.access(data, disabler);
  }

  isDragging(node: Identity | T) {
    const id = this.identifyNull(node);
    if (!id) return false;
    return this.state.nodes.drag.id === id;
  }

  isLoading(id?: string) {
    if (!id) return false;
    return this.state.nodes.loading.ids.has(id);
  }

  isFocused(id: string) {
    return this.hasFocus && this.state.nodes.focus.id === id;
  }

  isMatch(node: NodeApi<T>) {
    return this.matchFn(node);
  }

  willReceiveDrop(node: Identity | T) {
    const id = this.identifyNull(node);
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

  private loadDataOnOpen(node: NodeApi<T> | null) {
    if (!node || node.isRoot || node.isLeaf || node.children?.length) return;
    this.loadData(node).catch(utils.noop);
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
    const sourceHalfCheckedIds = this.props.halfCheckedIds;
    const checkStrictly = this.props.checkStrictly === true;

    // If the source checked ids and checkStrictly mode are unchanged since the last call, return the cached checked state. This is an important optimization
    // because computing checked state can be expensive in large trees, and this
    // method is called frequently during render.
    if (
      this.checkedStateCache?.root === this.root &&
      this.checkedStateCache.sourceIds === sourceIds &&
      this.checkedStateCache.sourceHalfCheckedIds === sourceHalfCheckedIds &&
      this.checkedStateCache.checkStrictly === checkStrictly
    ) {
      return this.checkedStateCache;
    }

    const checkedIds = this.normalizeCheckedIds(new Set(sourceIds));
    const halfCheckedIds = this.mergeHalfCheckedIds(
      checkedIds,
      this.getHalfCheckedIds(checkedIds),
    );
    this.checkedStateCache = {
      root: this.root,
      sourceIds,
      sourceHalfCheckedIds,
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

  // 根据外部传入的半选中节点列表，合并当前计算出的半选中节点列表，如果halfCheckedIds中有节点在checkedIds中，则将其剔除
  private mergeHalfCheckedIds(
    checkedIds: Set<string>,
    halfCheckedIds: Set<string>,
  ) {
    const externalIds = this.props.halfCheckedIds;
    if (!externalIds?.length) return halfCheckedIds;

    const ids = new Set(halfCheckedIds);
    externalIds.forEach((id) => {
      if (id !== ROOT_ID && !checkedIds.has(id)) ids.add(id);
    });
    return ids;
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
