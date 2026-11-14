import { expect, test } from "vite-plus/test";
import { expectNoSentinel, SENTINEL } from "../src/testing/leaks";
import { Secret } from "../src/index";

const hidden = new Error("plain");
Object.defineProperty(hidden, "body", { value: SENTINEL, enumerable: false });

const places: [string, unknown][] = [
  ["a string", `token ${SENTINEL}`],
  ["an error's message", new Error(SENTINEL)],
  ["an error's cause", new Error("outer", { cause: SENTINEL })],
  [
    "a nested error's cause",
    new Error("outer", { cause: new Error("inner", { cause: SENTINEL }) }),
  ],
  ["an error's enumerable property", Object.assign(new Error("plain"), { token: SENTINEL })],
  ["an error's non-enumerable property", hidden],
  ["an aggregate error's errors", new AggregateError([new Error(SENTINEL)], "many")],
  ["a nested object", { a: [{ b: SENTINEL }] }],
  ["an object key", { [SENTINEL]: 1 }],
  ["a Map key", new Map([[SENTINEL, 1]])],
  ["a Map value", new Map([["k", { v: SENTINEL }]])],
  ["a Set value", new Set([SENTINEL])],
  ["a Uint8Array", new TextEncoder().encode(SENTINEL)],
  ["a Buffer", Buffer.from(`x${SENTINEL}x`)],
];

test.each(places)("catches the sentinel in %s", (_, value) => {
  expect(() => expectNoSentinel("clean", value)).toThrow();
});

test("passes clean values, a Secret holding the sentinel, and cycles", () => {
  const cycle: Record<string, unknown> = { name: "loop" };
  cycle.self = cycle;
  const error = new Error("outer");
  error.cause = error;
  const map = new Map<unknown, unknown>();
  map.set(map, map);
  expectNoSentinel(cycle, error, map, new Secret(SENTINEL), 42, null, undefined, () => SENTINEL);
});

test("catches the sentinel behind a cycle", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  cycle.deep = { back: cycle, leak: SENTINEL };
  expect(() => expectNoSentinel(cycle)).toThrow();
});
