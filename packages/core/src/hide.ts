export function hideSecrets(text: string, secrets: readonly unknown[]): string {
  const forms = new Set<string>();
  for (const secret of secrets)
    if (typeof secret === "string" && secret) {
      forms.add(secret);
      forms.add(JSON.stringify(secret).slice(1, -1));
    }
  const covered = new Uint8Array(text.length);
  let found = false;
  for (const form of forms) {
    let filled = 0;
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      covered.fill(1, Math.max(at, filled), at + form.length);
      filled = at + form.length;
      found = true;
    }
  }
  if (!found) return text;
  let shown = "";
  let at = 0;
  while (at < text.length) {
    const start = at;
    const hidden = covered[at] === 1;
    while (at < text.length && (covered[at] === 1) === hidden) at += 1;
    shown += hidden ? "[hidden]" : text.slice(start, at);
  }
  return shown;
}
