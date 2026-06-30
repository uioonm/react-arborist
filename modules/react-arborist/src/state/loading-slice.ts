import { ActionTypes, IdObj } from "../types/utils";
import { identify } from "../utils";
import { initialState } from "./initial";

/* Types */
export type LoadingState = {
  ids: Set<string>;
};

type LoadableId = string | IdObj;

/* Actions */
export const actions = {
  add: (id: LoadableId | readonly LoadableId[]) => ({
    type: "LOADING_ADD" as const,
    ids: (Array.isArray(id) ? id : [id]).map(identify),
  }),

  remove: (id: LoadableId | readonly LoadableId[]) => ({
    type: "LOADING_REMOVE" as const,
    ids: (Array.isArray(id) ? id : [id]).map(identify),
  }),
};

/* Reducer */
export function reducer(
  state: LoadingState = initialState()["nodes"]["loading"],
  action: ActionTypes<typeof actions>,
): LoadingState {
  switch (action.type) {
    case "LOADING_ADD": {
      if (action.ids.length === 0) return state;
      const ids = new Set(state.ids);
      action.ids.forEach((id) => ids.add(id));
      return { ...state, ids };
    }
    case "LOADING_REMOVE": {
      if (action.ids.length === 0) return state;
      const ids = new Set(state.ids);
      action.ids.forEach((id) => ids.delete(id));
      return { ...state, ids };
    }
    default:
      return state;
  }
}
