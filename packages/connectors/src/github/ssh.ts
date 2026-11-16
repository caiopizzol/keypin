import { execFile } from "node:child_process";
import { withoutSignIn } from "@keypin/core";

const SSH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;

export function isSshName(name: string): boolean {
  return SSH_NAME.test(name);
}

export function sshHostname(
  destination: string,
  signIn: readonly string[],
): Promise<string | null> {
  const at = destination.lastIndexOf("@");
  const names = at === -1 ? [destination] : [destination.slice(0, at), destination.slice(at + 1)];
  if (!names.every(isSshName)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "ssh",
      ["-G", "--", destination],
      { timeout: 3000, env: withoutSignIn(process.env, signIn) },
      (error, stdout) => {
        const line = error ? undefined : /^hostname\s+(\S+)\s*$/m.exec(String(stdout));
        resolve(line?.[1] ?? null);
      },
    );
  });
}
