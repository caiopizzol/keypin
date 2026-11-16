export function signInVariables(
  kinds: readonly { readonly signInVariables?: readonly string[] }[],
): readonly string[] {
  return [...new Set(kinds.flatMap((kind) => kind.signInVariables ?? []))];
}

export function withoutSignIn(
  env: Readonly<Record<string, string | undefined>>,
  signIn: readonly string[],
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !signIn.includes(name)) kept[name] = value;
  return kept;
}
