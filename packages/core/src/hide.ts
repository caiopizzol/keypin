export function hideSecrets(text: string, secrets: readonly unknown[]): string {
  const forms = new Set<string>();
  for (const secret of secrets)
    if (typeof secret === "string" && secret) {
      forms.add(secret);
      forms.add(JSON.stringify(secret).slice(1, -1));
    }
  const spans: [number, number][] = [];
  for (const form of forms)
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1))
      spans.push([at, at + form.length]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of spans) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  let shown = "";
  let kept = 0;
  for (const [from, to] of merged) {
    shown += `${text.slice(kept, from)}[hidden]`;
    kept = to;
  }
  return shown + text.slice(kept);
}
