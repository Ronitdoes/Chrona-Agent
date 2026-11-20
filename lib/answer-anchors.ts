type MarkdownNode = {
  type: string;
  depth?: number;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
};

function plainText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(plainText).join("") ?? "";
}

export function answerAnchors(tree: MarkdownNode) {
  const nodes = tree.children ?? [];
  return nodes.flatMap((node, index) => {
    const offset = node.position?.start.offset;
    if (offset === undefined || (node.type !== "heading" && node.type !== "paragraph")) return [];
    const boundary = node.type === "heading"
      ? nodes.findIndex((next, nextIndex) => nextIndex > index && next.type === "heading" && next.depth! <= node.depth!)
      : index + 1;
    return [{ id: `a${offset}`, type: node.type, text: plainText(node).trim().slice(0, 360),
      before: boundary === -1 ? nodes.length : boundary }];
  });
}

/** Insert into the same Markdown tree, preserving references and block structure. */
export function remarkAnswerFigures(blocks: ReadonlyArray<{ id: string; anchor: string }>) {
  return (tree: MarkdownNode) => {
    if (!tree.children || !blocks.length) return;
    const anchors = new Map(answerAnchors(tree).map(anchor => [anchor.id, anchor.before]));
    const insertions = new Map<number, MarkdownNode[]>();
    for (const block of blocks) {
      const index = anchors.get(block.anchor);
      if (index === undefined) continue;
      const node = { type: "answerFigure", data: { hName: "div", hProperties: { "data-answer-figure": block.id } }, children: [] };
      insertions.set(index, [...(insertions.get(index) ?? []), node]);
    }
    tree.children = [...tree.children.flatMap((node, index) => [...(insertions.get(index) ?? []), node]),
      ...(insertions.get(tree.children.length) ?? [])];
  };
}
