import { fstatSync } from "node:fs";

export interface LogStream {
  fd: number;
  write(chunk: string, done: (error?: Error | null) => void): boolean;
}

export function maskCommands(
  env: Readonly<Record<string, string | undefined>>,
  values: readonly string[],
): string {
  if (env.GITHUB_ACTIONS !== "true") return "";
  const lines = new Set(values.flatMap((value) => value.split(/\r\n|\r|\n/)).map((l) => l.trim()));
  lines.delete("");
  return [...lines].map((line) => `::add-mask::${line.replaceAll("%", "%25")}\n`).join("");
}

export async function maskInLog(
  env: Readonly<Record<string, string | undefined>>,
  values: readonly string[],
  stderr: LogStream,
): Promise<void> {
  const commands = maskCommands(env, values);
  if (commands && readByRunner(stderr.fd)) await flushed(stderr, commands);
}

function readByRunner(fd: number): boolean {
  const stat = fstatSync(fd);
  return stat.isFIFO() || stat.isSocket();
}

function flushed(stream: LogStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}
