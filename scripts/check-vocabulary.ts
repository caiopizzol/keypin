import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const BANNED: [RegExp, string][] = [
  [/\bsync(?:s|ed|ing)?\b/gi, "publish"],
  [/\benv[\s-]?vars?\b/gi, "key"],
  [/\bmanifests?\b/gi, "secretspec.toml"],
  [/\bthe\s+map\b/gi, "secretspec.toml"],
  [/\bsinks?\b/gi, "destination"],
];

const SOURCES: [string, string][] = [
  ["docs", ".md"],
  ["apps/cli/tests/recordings", ".txt"],
];
const FILES = ["README.md", "skills/keypin/SKILL.md"];

const parser = unified().use(remarkParse).use(remarkGfm);

const walk = (node: Nodes): Nodes[] => [
  node,
  ...("children" in node ? node.children.flatMap(walk) : []),
];

function files(root: string): string[] {
  const found = SOURCES.flatMap(([dir, extension]) =>
    readdirSync(join(root, dir), { encoding: "utf8", recursive: true })
      .filter((name) => name.endsWith(extension))
      .map((name) => posix.join(dir, name)),
  );
  return [...FILES, ...found.sort()];
}

type Passage = { line: number; text: string };

function passages(file: string, source: string): Passage[] {
  if (!file.endsWith(".md"))
    return source.split("\n").map((text, index) => ({ line: index + 1, text }));
  return walk(parser.parse(source)).flatMap((node) =>
    node.type === "text" || node.type === "inlineCode" || node.type === "code"
      ? [
          {
            line: (node.position?.start.line ?? 1) + (node.type === "code" ? 1 : 0),
            text: node.value,
          },
        ]
      : [],
  );
}

export function vocabularyProblems(root: string): string[] {
  return files(root).flatMap((file) =>
    passages(file, readFileSync(join(root, file), "utf8"))
      .flatMap(({ line, text }) =>
        BANNED.flatMap(([pattern, instead]) =>
          [...text.matchAll(pattern)].map((match) => ({
            line: line + (text.slice(0, match.index).match(/\n/g)?.length ?? 0),
            text: `say "${instead}", not "${match[0].replace(/\s+/g, " ")}". See BRAND.md#vocabulary.`,
          })),
        ),
      )
      .sort((a, b) => a.line - b.line)
      .map((problem) => `${file}:${problem.line}: ${problem.text}`),
  );
}
