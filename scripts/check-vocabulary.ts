import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const BANNED: [RegExp, string][] = [
  [/\bsync(?:s|ed|ing)?\b/gi, "publish"],
  [/\benv[ -]?vars?\b/gi, "key"],
  [/\bmanifests?\b/gi, "secretspec.toml"],
  [/\bthe map\b/gi, "secretspec.toml"],
  [/\bsinks?\b/gi, "destination"],
];

const SOURCES: [string, string][] = [
  ["docs", ".md"],
  ["apps/cli/tests/recordings", ".txt"],
];
const FILES = ["README.md", "skills/keypin/SKILL.md"];

function files(root: string): string[] {
  const found = SOURCES.flatMap(([dir, extension]) =>
    readdirSync(join(root, dir), { encoding: "utf8", recursive: true })
      .filter((name) => name.endsWith(extension))
      .map((name) => posix.join(dir, name)),
  );
  return [...FILES, ...found.sort()];
}

export function vocabularyProblems(root: string): string[] {
  return files(root).flatMap((file) =>
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .flatMap((line, index) =>
        BANNED.flatMap(([pattern, instead]) =>
          [...line.matchAll(pattern)].map(
            (match) =>
              `${file}:${index + 1}: say "${instead}", not "${match[0]}". See BRAND.md#vocabulary.`,
          ),
        ),
      ),
  );
}
