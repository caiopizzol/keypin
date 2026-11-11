import { Console } from "node:console";
import { Writable } from "node:stream";
import { format, inspect } from "node:util";
import { expect, test } from "vite-plus/test";
import { generationOf, Secret } from "../src/index";

const SENTINEL = "sentinel-value-7f3a9c";

function captureConsole(print: (console: Console) => void): string {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  print(new Console({ stdout: stream, stderr: stream }));
  return chunks.join("");
}

test("no printing path shows the value", () => {
  const secret = new Secret(SENTINEL);
  const nested = { token: secret, list: [secret], deeper: { secret } };
  const outputs = [
    captureConsole((c) => {
      c.log(secret);
      c.log(nested);
      c.error("%s %o %O %j", secret, secret, nested, nested);
      c.dir(nested, { depth: 5 });
    }),
    "" + secret,
    String(secret),
    JSON.stringify(secret),
    JSON.stringify(nested),
    inspect(secret),
    inspect(nested, { depth: 10, showHidden: true }),
    format("%s %o %O %j", secret, secret, nested, nested),
    Bun.inspect(secret),
    Bun.inspect(nested),
    JSON.stringify(Object.assign({}, secret)),
    Object.keys(secret).join(","),
  ];
  for (const output of outputs) expect(output).not.toContain(SENTINEL);
  expect(String(secret)).toBe("[secret]");
  expect(inspect(secret)).toBe("[secret]");
  expect(Bun.inspect(secret)).toBe("[secret]");
  expect(JSON.stringify(nested)).toBe(
    '{"token":"[secret]","list":["[secret]"],"deeper":{"secret":"[secret]"}}',
  );
});

test("reveal returns the value", () => {
  expect(new Secret(SENTINEL).reveal()).toBe(SENTINEL);
});

test("a secret compares without handing out its value", () => {
  const secret = new Secret(SENTINEL);
  expect(secret.equals(new Secret(SENTINEL))).toBe(true);
  expect(secret.equals(new Secret("other"))).toBe(false);
  expect(secret.isEmpty()).toBe(false);
  expect(new Secret("").isEmpty()).toBe(true);
  expect(secret.includes("7f3a")).toBe(true);
  expect(secret.includes("$")).toBe(false);
});

test("a generation is the first 16 hex characters of the value's SHA-256", async () => {
  expect(await generationOf(new Secret("abc"))).toBe("ba7816bf8f01cfea");
  expect(await generationOf(new Secret(SENTINEL))).not.toContain(SENTINEL);
});
