import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import GithubSlugger from "github-slugger";
import type { Nodes, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const INDEX = "docs/README.md";
const UNLISTED = new Set([INDEX, "docs/development.md"]);
const ROOT_FILES = ["README.md", "skills/keypin/SKILL.md"];
const REPO_URL = "https://github.com/caiopizzol/keypin/blob/main/";
const SCHEME = /^[a-z][a-z0-9+.-]*:|^\/\//i;
const POINTER = /^# .+\n+Moved to \[/;
const HTML_ANCHOR = /<a\s[^>]*\b(?:name|id)="([^"]+)"/g;
const LANGUAGES = new Set(["toml", "sh", "yaml", "sql", "json", "mermaid"]);
const FLOW_HEADER = /^flowchart\s+LR$/;
const FLOW_EDGE =
  /^(\w+)(?:\["([^"]*)"\])?\s*(?:--\s*([^-"]+?)\s*-->|-->)\s*(\w+)(?:\["([^"]*)"\])?$/;

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

const parser = unified().use(remarkParse).use(remarkGfm);

const walk = (node: Nodes): Nodes[] => [
  node,
  ...("children" in node ? node.children.flatMap(walk) : []),
];

export function drawsAsChain(source: string): boolean {
  const [header, ...lines] = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (header === undefined || !FLOW_HEADER.test(header) || lines.length === 0) return false;
  const labels = new Map<string, string | undefined>();
  const next = new Map<string, string>();
  const into = new Set<string>();
  const define = (id: string, label: string | undefined) => {
    const known = labels.get(id);
    labels.set(id, label ?? known);
    return label === undefined || known === undefined || known === label;
  };
  for (const line of lines) {
    const [, from = "", fromLabel, , to = "", toLabel] = FLOW_EDGE.exec(line) ?? [];
    if (!from || !define(from, fromLabel) || !define(to, toLabel)) return false;
    if (next.has(from) || into.has(to)) return false;
    next.set(from, to);
    into.add(to);
  }
  const starts = [...labels.keys()].filter((id) => !into.has(id));
  let seen = 0;
  for (let id = starts.length === 1 ? starts[0] : undefined; id !== undefined; id = next.get(id))
    seen += 1;
  return seen === labels.size;
}

function markdownFiles(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { encoding: "utf8", recursive: true })
    .filter((name) => name.endsWith(".md"))
    .map((name) => posix.join(dir, name))
    .sort();
}

function listedPages(tree: Root): { pages: string[]; problems: string[] } {
  const pages: string[] = [];
  const problems: string[] = [];
  let sections = 0;
  for (const node of tree.children) {
    if (node.type === "heading" && node.depth === 2) sections += 1;
    if (node.type !== "list") continue;
    if (sections === 0) problems.push(`${INDEX} lists pages before its first ## section.`);
    for (const item of node.children) {
      const paragraph = item.children[0];
      const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
      const single = item.children.length === 1 && paragraph?.type === "paragraph";
      if (!single || paragraph.children.length !== 1 || link?.type !== "link") {
        problems.push(`${INDEX} has a list item that isn't one link to a page.`);
        continue;
      }
      const path = posix.normalize(link.url);
      if (
        SCHEME.test(link.url) ||
        /[?#]/.test(link.url) ||
        !path.endsWith(".md") ||
        path.startsWith("../") ||
        posix.isAbsolute(path)
      ) {
        problems.push(`${INDEX} links to ${link.url}, not a page in docs/.`);
        continue;
      }
      const page = posix.join("docs", path);
      if (pages.includes(page)) problems.push(`${INDEX} lists ${path} twice.`);
      else pages.push(page);
    }
  }
  return { pages, problems };
}

export function docsProblems(root: string): string[] {
  const trees = new Map<string, Root>();
  const tree = (file: string) => {
    const parsed = trees.get(file) ?? parser.parse(readFileSync(join(root, file), "utf8"));
    trees.set(file, parsed);
    return parsed;
  };
  const files = [
    ...ROOT_FILES.filter((file) => existsSync(join(root, file))),
    ...markdownFiles(root, "docs"),
  ];
  const { pages, problems } = existsSync(join(root, INDEX))
    ? listedPages(tree(INDEX))
    : { pages: [], problems: [`${INDEX} is missing.`] };
  const listed = new Set(pages);

  for (const file of files)
    if (
      file.startsWith("docs/") &&
      !listed.has(file) &&
      !UNLISTED.has(file) &&
      !POINTER.test(readFileSync(join(root, file), "utf8"))
    )
      problems.push(`${file} isn't listed in ${INDEX}.`);

  const anchors = (file: string) => {
    const slugger = new GithubSlugger();
    const nodes = walk(tree(file));
    const ids = nodes.flatMap((node) =>
      node.type === "heading" ? [slugger.slug(toString(node, { includeHtml: false }))] : [],
    );
    if (listed.has(file)) return ids;
    const html = nodes.flatMap((node) =>
      node.type === "html"
        ? [...node.value.matchAll(HTML_ANCHOR)].map((match) => match[1] ?? "")
        : [],
    );
    return [...ids, ...html];
  };

  for (const file of files) {
    if (!existsSync(join(root, file))) continue;
    const nodes = walk(tree(file));
    if (listed.has(file)) {
      const titles = nodes.filter((node) => node.type === "heading" && node.depth === 1);
      const first = tree(file).children.find(
        (node) => node.type !== "html" && node.type !== "definition",
      );
      if (titles.length !== 1 || first?.type !== "heading" || first.depth !== 1)
        problems.push(`${file} needs to start with its one # title.`);
      for (const node of nodes) {
        if (node.type !== "code" || node.lang === null || node.lang === undefined) continue;
        if (!LANGUAGES.has(node.lang))
          problems.push(
            `${file} has a ${node.lang} code block; keypin.dev highlights ${[...LANGUAGES].join(", ")}.`,
          );
        else if (node.lang === "mermaid" && !drawsAsChain(node.value))
          problems.push(
            `${file} has a mermaid diagram keypin.dev can't draw. It draws one "flowchart LR" chain, each line like a["Title<br>detail"] -- label --> b["Title"].`,
          );
      }
    }
    for (const node of nodes) {
      if (node.type !== "link" && node.type !== "definition" && node.type !== "image") continue;
      const url = node.url.startsWith(REPO_URL) ? `/${node.url.slice(REPO_URL.length)}` : node.url;
      if (SCHEME.test(url)) continue;
      const at = url.indexOf("#");
      const path = decoded((at === -1 ? url : url.slice(0, at)).split("?")[0] ?? "");
      const id = at === -1 ? "" : decoded(url.slice(at + 1));
      if (path === null || id === null) {
        problems.push(`${file} links to ${node.url}, which has a malformed % escape.`);
        continue;
      }
      const target =
        path === ""
          ? file
          : posix.normalize(
              posix.isAbsolute(path) ? path.slice(1) : posix.join(posix.dirname(file), path),
            );
      const relative = node.url === url;
      if (relative && url.startsWith("/"))
        problems.push(`${file} links to ${node.url}; use a path relative to the file.`);
      else if (target === ".." || target.startsWith("../"))
        problems.push(`${file} links to ${node.url}, outside keypin's repo.`);
      else if (!existsSync(join(root, target)))
        problems.push(`${file} links to ${node.url}, which doesn't exist.`);
      else if (
        relative &&
        listed.has(file) &&
        target.startsWith("docs/") &&
        target.endsWith(".md") &&
        !listed.has(target)
      )
        problems.push(
          `${file} links to ${node.url}, which ${INDEX} doesn't list, so keypin.dev can't link it.`,
        );
      else if (id !== "" && target.endsWith(".md") && !anchors(target).includes(id))
        problems.push(`${file} links to ${node.url}, a heading that doesn't exist.`);
    }
  }
  return problems;
}
