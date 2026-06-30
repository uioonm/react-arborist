import { ActionFromReducer, combineReducers } from "redux";
import { reducer as focus } from "./focus-slice";
import { reducer as edit } from "./edit-slice";
import { reducer as dnd } from "./dnd-slice";
import { reducer as selection } from "./selection-slice";
import { reducer as checked } from "./checked-slice";
import { reducer as loading } from "./loading-slice";
import { reducer as open } from "./open-slice";
import { reducer as drag } from "./drag-slice";

export const rootReducer = combineReducers({
  nodes: combineReducers({
    focus,
    edit,
    open,
    selection,
    checked,
    loading,
    drag,
  }),
  dnd,
});

export type RootState = ReturnType<typeof rootReducer>;
export type Actions = ActionFromReducer<typeof rootReducer>;
