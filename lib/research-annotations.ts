import { asOfDate, verdictFromLabel, type Verdict } from "./research-ui";

type Node = {
  type: string; value?: string; children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};
const skip = new Set(["code", "inlineCode", "html", "link", "linkReference", "image", "imageReference", "blockquote", "researchVerdict", "researchDate"]);
const month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const datePattern = new RegExp(`\\bas[ -]of\\s+(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+${month}\\s+\\d{4}|${month}\\s+\\d{1,2},?\\s+\\d{4})(?![\\w-])`, "gi");
const prefixPattern = /^(\s*)(changed|unchanged|couldn[’']t verify|could not verify)(?=\s*(?:$|[:—–-]))/i;

function badge(value: string, verdict: Verdict): Node {
  return { type: "researchVerdict", data: { hName: "span", hProperties: { "data-verdict": verdict } }, children: [{ type: "text", value }] };
}
function decorateDate(node: Node): Node[] {
  if (node.type !== "text" || !node.value) return [node];
  const result: Node[] = [];
  let offset = 0;
  for (const match of node.value.matchAll(datePattern)) {
    const date = asOfDate(match[1]);
    if (!date) continue;
    if (match.index > offset) result.push({ type: "text", value: node.value.slice(offset, match.index) });
    result.push({ type: "researchDate", data: { hName: "span", hProperties: { "data-as-of": date } }, children: [{ type: "text", value: match[0] }] });
    offset = match.index + match[0].length;
  }
  if (!offset) return [node];
  if (offset < node.value.length) result.push({ type: "text", value: node.value.slice(offset) });
  return result;
}

/** Cosmetic annotations of explicit labels only; never infer or calculate a verdict. */
export function annotateResearchTree(node: Node): void {
  if (skip.has(node.type) || !node.children) return;
  const exact = node.children.every((child) => child.type === "text") ? node.children.map((child) => child.value ?? "").join("") : "";
  const verdict = verdictFromLabel(exact);
  if (verdict && ["strong", "paragraph", "heading", "tableCell"].includes(node.type)) {
    node.children = [badge(exact, verdict)];
    return;
  }
  if (["strong", "paragraph", "heading", "tableCell"].includes(node.type) && node.children[0]?.type === "text") {
    const text = node.children[0].value ?? "";
    const prefix = prefixPattern.exec(text);
    const verdict = prefix ? verdictFromLabel(prefix[2]) : null;
    if (prefix && verdict) node.children.splice(0, 1,
      ...(prefix[1] ? [{ type: "text", value: prefix[1] }] : []),
      badge(prefix[2], verdict), { type: "text", value: text.slice(prefix[0].length) },
    );
  }
  for (const child of node.children) annotateResearchTree(child);
  node.children = node.children.flatMap(decorateDate);
}

export function remarkResearchAnnotations() {
  return annotateResearchTree;
}
