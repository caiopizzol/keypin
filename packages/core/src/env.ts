export const OIDC_TOKEN_REQUEST = [
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
] as const;

export function signInVariables(
  kinds: readonly { readonly signInVariables?: readonly string[] }[],
): readonly string[] {
  return [...new Set(kinds.flatMap((kind) => kind.signInVariables ?? []))];
}

export function withoutSignIn(
  env: Readonly<Record<string, string | undefined>>,
  signIn: readonly string[],
): Record<string, string> {
  const dropped = new Set<string>([...OIDC_TOKEN_REQUEST, ...signIn]);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !dropped.has(name)) kept[name] = value;
  return kept;
}
