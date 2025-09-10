import React from "react";
import { forwardRef } from "react";
import { useTreeApi } from "../context";

export const ListInnerElement = forwardRef<any, any>(function InnerElement(
  { style, ...rest },
  ref,
) {
  const tree = useTreeApi();
  const top = rest.children[0]?.props.style.top ?? 0;
  const translateY = top + (tree.props.padding ?? tree.props.paddingTop ?? 0);
  return (
    <div
      ref={ref}
      style={{
        transform: `translateY(${translateY}px)`,
        minWidth: "100%",
        width: "fit-content",
      }}
      {...rest}
    />
  );
});
