import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const page = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");

describe("keypin-site pages", () => {
  test("the landing page loads no script", () => {
    expect(page("index.html")).not.toMatch(/<script/i);
  });

  test("the team page loads only its own script", () => {
    const tags = [...page("team.html").matchAll(/<script\b[^>]*>/gi)].map((tag) => tag[0]);
    expect(tags).toEqual(['<script src="/team.js" defer>']);
  });
});
