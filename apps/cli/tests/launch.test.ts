import { describe, expect, test } from "vite-plus/test";
import { launch } from "../src/launch";

describe("launch", () => {
  test("passes the environment and the exit code through", async () => {
    const child = launch(["sh", "-c", 'test "$KEYS_TEST" = ok && exit 7'], { KEYS_TEST: "ok" });
    expect(await child.exited).toBe(7);
  });

  test("a child ended by a signal exits with 128 + its number", async () => {
    const child = launch(["sh", "-c", "kill -TERM $$"], {});
    expect(await child.exited).toBe(143);
  });
});
