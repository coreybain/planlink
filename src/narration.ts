import * as parse5 from "parse5";

const HEADING_PATTERN = /^h([1-6])$/;

export interface NarrationSection {
  narrationId: string;
  title: string;
  text: string;
  source: "explicit" | "section";
}

interface HtmlNode {
  tagName?: string;
  nodeName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
}

interface FlatNode {
  node: HtmlNode;
  heading?: {
    level: number;
    title: string;
  };
}

export function extractNarrationSections(html: string): NarrationSection[] {
  const document = parse5.parse(html) as HtmlNode;
  const explicit = extractExplicitNarration(document);
  if (explicit.length) return explicit;
  return extractHeadingNarration(document);
}

function extractExplicitNarration(document: HtmlNode): NarrationSection[] {
  const sections: NarrationSection[] = [];
  let currentTitle = "Plan overview";

  walk(document, (node) => {
    const heading = getHeading(node);
    if (heading) {
      currentTitle = heading.title;
    }

    if (!hasAttribute(node, "data-planlink-narration")) return;

    const text = cleanText(collectText(node));
    if (!text) return;

    const title = cleanText(getAttribute(node, "data-planlink-title")) || currentTitle;
    sections.push({
      narrationId: getAttribute(node, "id") || `narration-${sections.length + 1}`,
      title,
      text: clampText(text),
      source: "explicit"
    });
  });

  return sections.slice(0, 40);
}

function extractHeadingNarration(document: HtmlNode): NarrationSection[] {
  const flat: FlatNode[] = [];
  walk(document, (node) => flat.push({ node, heading: getHeading(node) || undefined }));

  const headingIndexes = flat
    .map((item, index) => ({ ...item, index }))
    .filter((item) => item.heading && item.heading.title);
  const preferredHeadingIndexes = headingIndexes.some((item) => item.heading?.level !== 1)
    ? headingIndexes.filter((item) => item.heading?.level !== 1)
    : headingIndexes;

  const sections = preferredHeadingIndexes.flatMap((item, preferredIndex) => {
    const heading = item.heading;
    if (!heading) return [];

    const nextBoundary = flat.findIndex((candidate, index) => (
      index > item.index
        && Boolean(candidate.heading)
        && Number(candidate.heading?.level) <= heading.level
    ));
    const endIndex = nextBoundary === -1 ? flat.length : nextBoundary;
    const sectionText = collectTextFromFlatRange(flat, item.index + 1, endIndex);
    const text = cleanText(`${heading.title}. ${sectionText}`);
    if (!sectionText || text.length < 40) return [];

    return [{
      narrationId: `section-${preferredIndex + 1}`,
      title: heading.title,
      text: clampText(text),
      source: "section" as const
    }];
  });

  if (sections.length) return sections.slice(0, 40);

  const bodyText = cleanText(collectText(document));
  if (!bodyText || bodyText.length < 40) return [];

  return [{
    narrationId: "section-1",
    title: "Plan overview",
    text: clampText(bodyText),
    source: "section"
  }];
}

function collectTextFromFlatRange(flat: FlatNode[], startIndex: number, endIndex: number): string {
  const values: string[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const item = flat[index];
    if (item.node.nodeName === "#text") {
      values.push(item.node.value || "");
    }
  }

  return cleanText(values.join(" "));
}

function getHeading(node: HtmlNode): { level: number; title: string } | null {
  const tagName = node.tagName?.toLowerCase();
  const match = tagName?.match(HEADING_PATTERN);
  if (!match) return null;

  const title = cleanText(collectText(node));
  if (!title) return null;

  return {
    level: Number(match[1]),
    title
  };
}

function walk(node: HtmlNode | undefined, visit: (node: HtmlNode) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.childNodes || []) {
    walk(child, visit);
  }
}

function collectText(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value || "";
  if (node.tagName && ["style", "script", "noscript"].includes(node.tagName.toLowerCase())) {
    return "";
  }

  return (node.childNodes || []).map(collectText).join(" ");
}

function hasAttribute(node: HtmlNode, name: string): boolean {
  return Boolean(node.attrs?.some((candidate) => candidate.name.toLowerCase() === name));
}

function getAttribute(node: HtmlNode, name: string): string | null {
  const attr = node.attrs?.find((candidate) => candidate.name.toLowerCase() === name);
  return attr?.value || null;
}

function cleanText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampText(value: string): string {
  if (value.length <= 2800) return value;
  return `${value.slice(0, 2790).trim()}...`;
}
