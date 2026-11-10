import { execFile } from "node:child_process";

export function ghToken(login: string): Promise<string> {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const args = ["auth", "token", "--hostname", "github.com", "--user", login];
  return new Promise((resolve, reject) => {
    execFile("gh", args, { env }, (error, stdout) => {
      const token = String(stdout).trim();
      if (error || !token)
        reject(new Error(`gh has no token for ${login}; run: gh auth login --hostname github.com`));
      else resolve(token);
    });
  });
}
