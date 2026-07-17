import { NodeApi } from "../interfaces/node-api";
import { TreeApi } from "../interfaces/tree-api";

export function createList<T>(tree: TreeApi<T>) {
  if (tree.isFiltered) {
    return flattenAndFilterTree(
      tree.root,
      tree.isMatch.bind(tree),
      tree.props.searchMatchKeepChildren,
    );
  } else {
    return flattenTree(tree.root);
  }
}

function flattenTree<T>(root: NodeApi<T>): NodeApi<T>[] {
  const list: NodeApi<T>[] = [];
  function collect(node: NodeApi<T>) {
    if (node.level >= 0) {
      list.push(node);
    }
    if (node.isOpen) {
      node.children?.forEach(collect);
    }
  }
  collect(root);
  list.forEach(assignRowIndex);
  return list;
}

function flattenAndFilterTree<T>(
  root: NodeApi<T>,
  isMatch: (n: NodeApi<T>) => boolean,
  keepChildrenOfMatches = false,
): NodeApi<T>[] {
  const matches: Record<string, boolean> = {};
  const list: NodeApi<T>[] = [];

  function markMatch(node: NodeApi<T>): boolean {
    const matchesSelf = !node.isRoot && isMatch(node);
    if (matchesSelf && keepChildrenOfMatches) {
      markDescendants(node);
      return true;
    }

    let matchesDescendant = false;
    node.children?.forEach((child) => {
      if (markMatch(child)) matchesDescendant = true;
    });
    const matchesSubtree = matchesSelf || matchesDescendant;
    if (matchesSubtree) matches[node.id] = true;
    return matchesSubtree;
  }

  function markDescendants(node: NodeApi<T>) {
    matches[node.id] = true;
    node.children?.forEach(markDescendants);
  }

  function collect(node: NodeApi<T>) {
    if (node.level >= 0 && matches[node.id]) {
      list.push(node);
    }
    if (node.isOpen) {
      node.children?.forEach(collect);
    }
  }

  markMatch(root);
  collect(root);
  list.forEach(assignRowIndex);
  return list;
}

function assignRowIndex(node: NodeApi<any>, index: number) {
  node.rowIndex = index;
}
