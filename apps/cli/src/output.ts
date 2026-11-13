import { stripVTControlCharacters } from "node:util";
import type { Deps, Writer } from "./deps";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 80;
const SLOW_MS = 1000;
const MIN_LABEL = 12;

export interface Done {
  ok: boolean;
  text: string;
}

export interface Output {
  line: (text?: string) => void;
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
  mark: (ok: boolean) => string;
  step<T>(
    running: string,
    work: () => Promise<T>,
    done: (result: T) => Done,
    slow?: string,
  ): Promise<T>;
}

export function isStyled(
  isTTY: boolean | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return Boolean(isTTY) && env.NO_COLOR === undefined && env.TERM !== "dumb";
}

export function output(stderr: Writer, styled: boolean, columns = () => 80): Output {
  const paint = (code: string) => (text: string) => (styled ? `\x1b[${code}m${text}\x1b[0m` : text);
  const green = paint("32");
  const red = paint("1;31");
  const dim = paint("2");
  const line = (text = "") => stderr.write(`${text}\n`);
  const mark = (ok: boolean) => (styled ? (ok ? green("✓") : red("✗")) : ok ? "ok    " : "FAILED");

  async function step<T>(
    running: string,
    work: () => Promise<T>,
    done: (result: T) => Done,
    slow?: string,
  ): Promise<T> {
    if (!styled) {
      try {
        const result = await work();
        const { ok, text } = done(result);
        line(`${mark(ok)} ${text}`);
        return result;
      } catch (error) {
        line(`${mark(false)} ${running}`);
        throw error;
      }
    }
    const started = Date.now();
    let frame = 0;
    const draw = () => {
      const width = columns() - 3;
      const hint = slow && Date.now() - started > SLOW_MS ? `  ${slow}` : "";
      const label = fit(running, Math.min(Math.max(width - hint.length, MIN_LABEL), width));
      const shown = `${label}${dim(fit(hint, width - label.length))}`;
      stderr.write(`\r\x1b[2K${green(FRAMES[frame++ % FRAMES.length] ?? "")} ${shown}`);
    };
    draw();
    const timer = setInterval(draw, TICK_MS);
    const finish = (ok: boolean, text: string) => {
      clearInterval(timer);
      stderr.write(`\r\x1b[2K${mark(ok)} ${text}  ${dim(seconds(Date.now() - started))}\n`);
    };
    try {
      const result = await work();
      const { ok, text } = done(result);
      finish(ok, text);
      return result;
    } catch (error) {
      finish(false, running);
      throw error;
    }
  }

  return { line, bold: paint("1"), dim, red, mark, step };
}

export async function confirm(deps: Pick<Deps, "ask">, question: string): Promise<boolean> {
  const answer = await deps.ask(`${question} [y/N] `);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

export function columns(rows: readonly (readonly string[])[]): string[][] {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(cell))));
  return rows.map((row) =>
    row.map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - visible(cell))),
  );
}

function visible(text: string): number {
  return stripVTControlCharacters(text).length;
}

export function tilde(text: string, home: string): string {
  return text.replaceAll(new RegExp(`(^|[\\s(])${RegExp.escape(home)}(?=/|$|[\\s)])`, "g"), "$1~");
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
