import { ActionTypes, IdObj } from "../types/utils";
import { identify } from "../utils";
import { initialState } from "./initial";

/* Types */
export type CheckedState = {
  ids: Set<string>;
};

type CheckableId = string | IdObj;

/* Actions */
export const actions = {
  clear: () => ({ type: "CHECKED_CLEAR" as const }),

  add: (id: CheckableId | readonly CheckableId[]) => ({
    type: "CHECKED_ADD" as const,
    ids: (Array.isArray(id) ? id : [id]).map(identify),
  }),

  remove: (id: CheckableId | readonly CheckableId[]) => ({
    type: "CHECKED_REMOVE" as const,
    ids: (Array.isArray(id) ? id : [id]).map(identify),
  }),

  set: (ids: Set<string>) => ({
    type: "CHECKED_SET" as const,
    ids,
  }),
};

/* Reducer */
export function reducer(
  state: CheckedState = initialState()["nodes"]["checked"],
  action: ActionTypes<typeof actions>
): CheckedState {
  switch (action.type) {
    case "CHECKED_CLEAR":
      return { ...state, ids: new Set() };
    case "CHECKED_ADD": {
      if (action.ids.length === 0) return state;
      const ids = new Set(state.ids);
      action.ids.forEach((id) => ids.add(id));
      return { ...state, ids };
    }
    case "CHECKED_REMOVE": {
      if (action.ids.length === 0) return state;
      const ids = new Set(state.ids);
      action.ids.forEach((id) => ids.delete(id));
      return { ...state, ids };
    }
    case "CHECKED_SET":
      return { ...state, ids: action.ids };
    default:
      return state;
  }
}
