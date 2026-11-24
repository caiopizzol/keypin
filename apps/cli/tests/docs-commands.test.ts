import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, test } from "vite-plus/test";
import { USAGE } from "../src/cli";

const ROOT = join(import.meta.dirname, "../../..");
const FILES = [
  "README.md",
  "skills/keypin/SKILL.md",
  ...readdirSync(join(ROOT, "docs"), { encoding: "utf8", recursive: true })
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];
const SHELL = new Set(["sh", "yaml"]);
const SEPARATOR = /&&|\|\||\$\(|[;|()`]/;
const LAUNCHER = new Set(["npx", "bunx", "then", "else", "do"]);
const KEYPIN = /^keypin(@\S+)?$/;
const FLAG = /^--?[a-z]/i;
const PLACEHOLDER = /^<[^>]+>$/;
const USAGE_LINE = /^ {2}keypin (\S+)(.*)$/;
const FIX = "Fix the doc, or the usage text in apps/cli/src/cli.ts.";

const commands = new Map<string, Set<string>>();
const HELP = new Set(["--help", "-h"]);
const topLevel = new Set<string>([...HELP, "help", "-v"]);
for (const line of USAGE.split("\n")) {
  const [, first = "", rest = ""] = USAGE_LINE.exec(line) ?? [];
  if (first.startsWith("-")) topLevel.add(first);
  else if (first) commands.set(first, new Set([...(commands.get(first) ?? []), ...flagsIn(rest)]));
}

function flagsIn(text: string): string[] {
  return text.split(/\s{3,}/)[0]?.match(/--[a-z][a-z-]*/g) ?? [];
}

type Invocation = { line: number; command: string; flags: string[] };

function joined(text: string): { offset: number; row: string }[] {
  const rows: { offset: number; row: string }[] = [];
  let open = false;
  text.split("\n").forEach((row, offset) => {
    const last = rows.at(-1);
    if (open && last) last.row = `${last.row.slice(0, -1)} ${row}`;
    else rows.push({ offset, row });
    open = row.endsWith("\\");
  });
  return rows;
}

function invocations(text: string, line: number): Invocation[] {
  return joined(text).flatMap(({ offset, row }) =>
    row
      .replace(/(^|\s)#.*$/, "")
      .replace(/^\s*-?\s*run:/, "")
      .split(SEPARATOR)
      .flatMap((segment) => {
        const words = segment.trim().split(/\s+/);
        let at = 0;
        while (/^\w+=/.test(words[at] ?? "") || LAUNCHER.has(words[at] ?? "")) {
          at += 1;
          while (FLAG.test(words[at] ?? "")) at += 1;
        }
        if (!KEYPIN.test(words[at] ?? "")) return [];
        const args = words.slice(at + 1);
        const end = args.findIndex((word) => word === "…" || word === "...");
        const [command = "", ...rest] = end === -1 ? args : args.slice(0, end);
        if (command === "") return [];
        const flags = [command, ...rest].filter((word) => FLAG.test(word));
        return [
          { line: line + offset, command, flags: flags.map((flag) => flag.split("=")[0] ?? flag) },
        ];
      }),
  );
}

const walk = (node: Nodes): Nodes[] => [
  node,
  ...("children" in node ? node.children.flatMap(walk) : []),
];

function found(markdown: string): Invocation[] {
  return walk(unified().use(remarkParse).use(remarkGfm).parse(markdown)).flatMap((node) => {
    const line = node.position?.start.line ?? 0;
    if (node.type === "inlineCode") return invocations(node.value, line);
    if (node.type === "code" && SHELL.has(node.lang ?? ""))
      return invocations(node.value, line + 1);
    return [];
  });
}

function problems(file: string, markdown: string): string[] {
  return found(markdown).flatMap(({ line, command, flags }) => {
    const top = command === "help" || command.startsWith("-");
    const any = top || PLACEHOLDER.test(command);
    const own = commands.get(command);
    const known = top ? topLevel : any ? HELP : own && new Set([...own, ...HELP]);
    if (known === undefined)
      return [`${file}:${line} runs keypin ${command}, a command keypin doesn't have. ${FIX}`];
    const named = any ? "keypin" : `keypin ${command}`;
    return flags
      .filter((flag) => !known.has(flag))
      .map((flag) => `${file}:${line} runs ${named} ${flag}, a flag ${named} doesn't have. ${FIX}`);
  });
}

const docs = FILES.map((file) => ({ file, markdown: readFileSync(join(ROOT, file), "utf8") }));

describe("keypin commands in the docs", () => {
  test("the usage text and the docs have commands to check", () => {
    expect([...commands.keys()].sort()).toEqual([
      "check",
      "publish",
      "rotate",
      "status",
      "unregister",
    ]);
    expect([...topLevel].sort()).toEqual(["--help", "--version", "-h", "-v", "help"]);
    expect(docs.flatMap(({ markdown }) => found(markdown)).length).toBeGreaterThanOrEqual(60);
  });

  test("name only commands and flags in keypin's usage text", () => {
    expect(docs.flatMap(({ file, markdown }) => problems(file, markdown))).toEqual([]);
  });

  test("a removed command or a flag a command lacks fails", () => {
    const markdown = [
      "Run `keypin import .env` first, then `keypin publish API_KEY --force`.",
      "",
      "```sh",
      "keypin init",
      "npx keypin@latest status --bogus # comment --ignored",
      "npm install -g keypin && keypin run -- node app.js",
      "keypin rotate API_KEY \\",
      "  --profile prod \\",
      "  --force",
      "```",
      "",
      "```yaml",
      "      - run: keypin rotate --due --yes --all",
      "```",
      "",
      "`keypin <command> --force`, `keypin --help`, `keypin check --json`, `git config user.name keypin`",
      "`keypin help`, `keypin status -h`, `keypin -v`, `keypin status --version`",
    ].join("\n");
    expect(problems("page.md", markdown).map((problem) => problem.replace(` ${FIX}`, ""))).toEqual([
      "page.md:1 runs keypin import, a command keypin doesn't have.",
      "page.md:1 runs keypin publish --force, a flag keypin publish doesn't have.",
      "page.md:4 runs keypin init, a command keypin doesn't have.",
      "page.md:5 runs keypin status --bogus, a flag keypin status doesn't have.",
      "page.md:6 runs keypin run, a command keypin doesn't have.",
      "page.md:7 runs keypin rotate --force, a flag keypin rotate doesn't have.",
      "page.md:13 runs keypin rotate --all, a flag keypin rotate doesn't have.",
      "page.md:16 runs keypin --force, a flag keypin doesn't have.",
      "page.md:17 runs keypin status --version, a flag keypin status doesn't have.",
    ]);
  });
});
