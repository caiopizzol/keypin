export function parseUrl(text: unknown): URL | null {
  if (typeof text !== "string") return null;
  try {
    const url = new URL(text);
    return url.protocol === "postgresql:" || url.protocol === "postgres:" ? url : null;
  } catch {
    return null;
  }
}

export function databaseOf(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return "";
  }
}

export function endpointOf(url: URL): string {
  return (url.hostname.split(".")[0] ?? "").replace(/-pooler$/, "");
}

export function userOf(url: URL | null): string | null {
  if (!url?.username) return null;
  try {
    return decodeURIComponent(url.username);
  } catch {
    return null;
  }
}
