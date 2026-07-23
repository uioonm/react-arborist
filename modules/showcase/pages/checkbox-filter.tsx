import Link from "next/link";
import { useState } from "react";
import { NodeRendererProps, Tree } from "react-arborist";

type Data = { id: string; name: string; children?: Data[] };

const data: Data[] = [
  {
    id: "engineering",
    name: "Engineering",
    children: [
      {
        id: "platform",
        name: "Platform",
        children: [
          {
            id: "identity",
            name: "Identity",
            children: [
              { id: "identity-api", name: "Identity API" },
              { id: "identity-web", name: "Identity Web" },
              { id: "identity-audit", name: "Identity Audit" },
            ],
          },
          {
            id: "runtime",
            name: "Runtime",
            children: [
              { id: "runtime-node", name: "Node Runtime" },
              { id: "runtime-edge", name: "Edge Runtime" },
            ],
          },
        ],
      },
      {
        id: "product",
        name: "Product Engineering",
        children: [
          {
            id: "web",
            name: "Web",
            children: [
              { id: "web-dashboard", name: "Dashboard" },
              { id: "web-settings", name: "Settings" },
            ],
          },
          {
            id: "mobile",
            name: "Mobile",
            children: [
              { id: "mobile-ios", name: "iOS" },
              { id: "mobile-android", name: "Android" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "operations",
    name: "Operations",
    children: [
      {
        id: "support",
        name: "Support",
        children: [
          { id: "support-enterprise", name: "Enterprise Support" },
          { id: "support-community", name: "Community Support" },
        ],
      },
      {
        id: "security",
        name: "Security",
        children: [
          { id: "security-response", name: "Incident Response" },
          { id: "security-compliance", name: "Compliance" },
        ],
      },
    ],
  },
];

export default function CheckboxFilter() {
  const [searchTerm, setSearchTerm] = useState("");
  const [checkedNames, setCheckedNames] = useState<string[]>([]);
  const [lastNode, setLastNode] = useState<string>("(none)");

  return (
    <main style={{ display: "grid", gap: 24, gridTemplateColumns: "minmax(320px, 1fr) 360px", padding: 32 }}>
      <section style={{ height: 620, border: "1px solid #ccc", borderRadius: 8 }}>
        <Tree<Data>
          data={data}
          openByDefault
          checkable
          height={620}
          width="100%"
          indent={24}
          rowHeight={34}
          searchTerm={searchTerm}
          onCheck={(nodes, node) => {
            setCheckedNames(nodes.map((checkedNode) => checkedNode.data.name));
            setLastNode(node?.data.name ?? "(batch operation)");
          }}
        >
          {Node}
        </Tree>
      </section>
      <aside>
        <h1>Filtered Parent Checking</h1>
        <p>
          Search for a leaf such as <code>Identity</code> or <code>API</code>, then check its
          parent. Only the visible leaf descendants are changed; previous hidden checks remain.
        </p>
        <label htmlFor="tree-search">Filter nodes</label>
        <input
          id="tree-search"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.currentTarget.value)}
          style={{ display: "block", fontSize: 16, margin: "8px 0 24px", padding: 8, width: "100%" }}
        />
        <p>
          <strong>Last operation:</strong> {lastNode}
        </p>
        <p>
          <strong>Checked nodes ({checkedNames.length}):</strong>
        </p>
        <ul>{checkedNames.map((name) => <li key={name}>{name}</li>)}</ul>
        <Link href="/">Back to demos</Link>
      </aside>
    </main>
  );
}

function Node({ node, style, dragHandle }: NodeRendererProps<Data>) {
  return (
    <div ref={dragHandle} style={{ ...style, alignItems: "center", display: "flex", gap: 8 }}>
      <button
        aria-label={node.isOpen ? `Collapse ${node.data.name}` : `Expand ${node.data.name}`}
        disabled={node.isLeaf}
        onClick={(event) => {
          event.stopPropagation();
          node.toggle();
        }}
        style={{ border: 0, background: "transparent", cursor: node.isLeaf ? "default" : "pointer", width: 20 }}
      >
        {node.isLeaf ? "" : node.isOpen ? "▾" : "▸"}
      </button>
      <input
        aria-label={`Check ${node.data.name}`}
        checked={node.isChecked}
        ref={(input) => {
          if (input) input.indeterminate = node.isHalfChecked;
        }}
        type="checkbox"
        onClick={(event) => event.stopPropagation()}
        onChange={() => node.toggleCheck()}
      />
      <span>{node.data.name}</span>
    </div>
  );
}
