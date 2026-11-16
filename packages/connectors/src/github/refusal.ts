export const NOT_ENTERPRISE =
  "keypin publishes only to github.com; GitHub Enterprise Server and ghe.com aren't supported yet";

export function ssoFix(headers: Headers, owner: string): string | null {
  const sso = headers.get("x-github-sso");
  if (sso === null || sso.includes("partial-results")) return null;
  const url = /\burl=([^;\s]+)/.exec(sso)?.[1];
  return url
    ? `authorize the gh token for SSO in ${owner}: ${url} (the link expires in an hour)`
    : `authorize the gh token for SSO in ${owner} on github.com`;
}

export function gitHubSaid(body: Record<string, unknown>, hide: readonly string[] = []): string {
  const secrets = hide.flatMap((h) => [h, h.trim()]).filter((h) => h);
  const [said] = [body.message]
    .map((m) => (typeof m === "string" ? m.trim() : ""))
    .filter((m) => m && !secrets.some((h) => m.includes(h)));
  if (said === undefined) return "";
  return `: ${said.length > 200 ? `${said.slice(0, 200)}…` : said}`;
}
