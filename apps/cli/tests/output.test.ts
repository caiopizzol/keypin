import { describe, expect, test, vi } from "vite-plus/test";
import { confirm, isStyled, output } from "../src/output";

const ESC = "\x1b";

function plain(text: string): string {
  return text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

function writer() {
  let text = "";
  return { write: (chunk: string) => void (text += chunk), text: () => text };
}

describe("output", () => {
  test("styling needs a terminal, and NO_COLOR or TERM=dumb turns it off", () => {
    expect(isStyled(true, {})).toBe(true);
    expect(isStyled(false, {})).toBe(false);
    expect(isStyled(undefined, {})).toBe(false);
    expect(isStyled(true, { NO_COLOR: "" })).toBe(false);
    expect(isStyled(true, { TERM: "dumb" })).toBe(false);
  });

  test("without styling, a step prints one plain line and no escape codes", async () => {
    const stderr = writer();
    const out = output(stderr, false);
    const result = await out.step(
      "Checking",
      async () => 7,
      (n) => ({ ok: n === 7, text: `Checked ${n}` }),
    );
    expect(result).toBe(7);
    expect(stderr.text()).toBe("ok     Checked 7\n");
  });

  test("with styling, a step ends on its own line with a mark and a time", async () => {
    const stderr = writer();
    const out = output(stderr, true);
    await out.step(
      "Checking",
      async () => false,
      () => ({ ok: false, text: "Checked" }),
    );
    const last = stderr.text().split(`${ESC}[2K`).at(-1) ?? "";
    expect(last.replaceAll(ESC, "ESC")).toMatch(
      /^ESC\[1;31m✗ESC\[0m Checked {2}ESC\[2m\d+\.\dsESC\[0m\n$/,
    );
  });

  test("a failed step clears its spinner and rethrows", async () => {
    const stderr = writer();
    const out = output(stderr, true);
    await expect(
      out.step(
        "Writing",
        () => Promise.reject(new Error("HTTP 500")),
        () => ({ ok: true, text: "" }),
      ),
    ).rejects.toThrow("HTTP 500");
    expect(stderr.text().replaceAll(ESC, "ESC")).toMatch(/✗ESC\[0m Writing {2}.*\n$/);
  });

  test("without styling, a failed step still prints its label and FAILED", async () => {
    const stderr = writer();
    const out = output(stderr, false);
    await expect(
      out.step(
        "GitHub  acme/billing  checking the account",
        () => Promise.reject(new Error("fetch failed")),
        () => ({ ok: true, text: "" }),
      ),
    ).rejects.toThrow("fetch failed");
    expect(stderr.text()).toBe("FAILED GitHub  acme/billing  checking the account\n");
  });

  test("a spinner frame never wraps, so each redraw replaces the whole frame", async () => {
    vi.useFakeTimers();
    try {
      const stderr = writer();
      const out = output(stderr, true, () => 80);
      const running = "Reading 1 value from 1Password account my.1password.com";
      const hint = "1Password may be asking you to approve keypin";
      let finish = () => {};
      const step = out.step(
        running,
        () => new Promise<void>((resolve) => (finish = resolve)),
        () => ({ ok: true, text: "Read" }),
        hint,
      );
      vi.advanceTimersByTime(1500);
      finish();
      await step;
      const frames = stderr
        .text()
        .split(`\r${ESC}[2K`)
        .filter((frame) => frame && !frame.endsWith("\n"));
      expect(frames.some((frame) => plain(frame).includes("1Password may"))).toBe(true);
      for (const frame of frames) expect(plain(frame).length).toBeLessThanOrEqual(79);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a long label gives way to the hint, which is never cut", async () => {
    vi.useFakeTimers();
    try {
      for (const width of [80, 72]) {
        const stderr = writer();
        const out = output(stderr, true, () => width);
        const running = "Looking up 4 items in 1Password account my.1password.com, not the values";
        const hint = "1Password may be asking you to approve keypin";
        let finish = () => {};
        const step = out.step(
          running,
          () => new Promise<void>((resolve) => (finish = resolve)),
          () => ({ ok: true, text: "Looked up" }),
          hint,
        );
        vi.advanceTimersByTime(1500);
        finish();
        await step;
        const frames = stderr
          .text()
          .split(`\r${ESC}[2K`)
          .filter((frame) => frame && !frame.endsWith("\n"))
          .map(plain);
        const last = frames.at(-1) ?? "";
        expect(last.endsWith(`  ${hint}`)).toBe(true);
        expect(last).toContain("Looking up");
        for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(width - 1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("on a terminal narrower than the minimum label, the frame still never wraps", async () => {
    vi.useFakeTimers();
    try {
      for (const width of [14, 12, 8, 4]) {
        const stderr = writer();
        const out = output(stderr, true, () => width);
        let finish = () => {};
        const step = out.step(
          "Reading 1 value",
          () => new Promise<void>((resolve) => (finish = resolve)),
          () => ({ ok: true, text: "Read" }),
          "1Password may be asking you to approve keypin",
        );
        vi.advanceTimersByTime(1500);
        finish();
        await step;
        const frames = stderr
          .text()
          .split(`\r${ESC}[2K`)
          .filter((frame) => frame && !frame.endsWith("\n"))
          .map(plain);
        for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(width - 1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("a hint that can't fit beside any label is cut, and the frame still never wraps", async () => {
    vi.useFakeTimers();
    try {
      const stderr = writer();
      const out = output(stderr, true, () => 30);
      let finish = () => {};
      const step = out.step(
        "Reading 1 value",
        () => new Promise<void>((resolve) => (finish = resolve)),
        () => ({ ok: true, text: "Read" }),
        "1Password may be asking you to approve keypin",
      );
      vi.advanceTimersByTime(1500);
      finish();
      await step;
      const frames = stderr
        .text()
        .split(`\r${ESC}[2K`)
        .filter((frame) => frame && !frame.endsWith("\n"))
        .map(plain);
      for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(29);
    } finally {
      vi.useRealTimers();
    }
  });

  test("confirm takes y or yes in any case, and anything else is no", async () => {
    const answers = async (answer: string) => confirm({ ask: async () => answer }, "Write?");
    for (const yes of ["y", "Y", "yes", " YES "]) expect(await answers(yes)).toBe(true);
    for (const no of ["", "n", "no", "yess", "sure"]) expect(await answers(no)).toBe(false);
  });
});
