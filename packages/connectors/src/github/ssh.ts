import { execFile } from "node:child_process";
import { withoutSignIn } from "@keypin/core";

export function sshHostname(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "ssh",
      ["-G", "--", host],
      { timeout: 3000, env: withoutSignIn(process.env) },
      (error, stdout) => {
        const line = error ? undefined : /^hostname\s+(\S+)\s*$/m.exec(String(stdout));
        resolve(line?.[1] ?? null);
      },
    );
  });
}
