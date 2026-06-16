import { forwardRef } from "react";
import { useTreeApi } from "../context";
import { Cursor } from "./cursor";

export const ListOuterElement = forwardRef(function Outer(
  props: React.HTMLProps<HTMLDivElement>,
  ref,
) {
  const { children, ...rest } = props;
  const tree = useTreeApi();
  const paddingTop = tree.props.padding ?? tree.props.paddingTop ?? 0;
  const paddingBottom = tree.props.padding ?? tree.props.paddingBottom ?? 0;
  return (
    <div
      // @ts-ignore
      ref={ref}
      {...rest}
      onClick={(e) => {
        if (e.currentTarget === e.target) tree.deselectAll();
      }}
    >
      <DropContainer paddingGap={paddingTop + paddingBottom} />
      {children}
    </div>
  );
});

export const DropContainer = ({ paddingGap }: { paddingGap: number }) => {
  const tree = useTreeApi();
  return (
    <div
      style={{
        height: tree.rowTopPosition(tree.visibleNodes.length) + paddingGap,
        width: "100%",
        position: "absolute",
        left: "0",
        right: "0",
      }}
    >
      <Cursor />
    </div>
  );
};
