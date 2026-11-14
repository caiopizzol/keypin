export const SIGN_IN_VARIABLES: readonly string[] = [
  "OP_SERVICE_ACCOUNT_TOKEN",
  "KEYPIN_1PASSWORD",
];

export function withoutSignIn(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !SIGN_IN_VARIABLES.includes(name)) kept[name] = value;
  return kept;
}
