import { useDrop } from "react-dnd";
import { useTreeApi } from "../context";
import { DragItem } from "../types/dnd";
import { computeDrop } from "./compute-drop";
import { DropResult } from "./drop-hook";
import { actions as dnd } from "../state/dnd-slice";
import { ROOT_ID } from "../data/create-root";

export function useOuterDrop() {
  const tree = useTreeApi();

  // In case we drop an item at the bottom of the list
  const [, drop] = useDrop<DragItem, DropResult | null, { isOver: boolean }>(
    () => ({
      accept: "NODE",
      canDrop: (_item, m) => {
        if (!m.isOver({ shallow: true })) return false;
        return tree.canDrop();
      },
      hover: (_item, m) => {
        if (!m.isOver({ shallow: true })) return;
        const offset = m.getClientOffset();
        if (!tree.listEl.current || !offset) return;
        const { cursor, drop } = computeDrop({
          element: tree.listEl.current,
          offset: offset,
          indent: tree.indent,
          node: null,
          prevNode: tree.visibleNodes[tree.visibleNodes.length - 1],
          nextNode: null,
        });
        if (drop) tree.dispatch(dnd.hovering(drop.parentId, drop.index));

        if (m.canDrop()) {
          if (cursor) tree.showCursor(cursor);
        } else {
          tree.hideCursor();
        }
      },
      drop: (_, monitor) => {
        if (!monitor.canDrop()) return null;
        const { parentId, index } = tree.state.dnd;
        tree.props.onMove?.({
          dragIds: tree.state.dnd.dragIds,
          parentId: parentId === ROOT_ID ? null : parentId,
          index: index === null ? 0 : index,
          dragNodes: tree.dragNodes,
          parentNode: tree.get(parentId),
        });
        return { parentId, index };
      },
    }),
    [tree]
  );

  drop(tree.listEl);
}
