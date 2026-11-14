export const SIGN_IN_VARIABLES: readonly string[] = [
  "OP_SERVICE_ACCOUNT_TOKEN",
  "KEYPIN_1PASSWORD",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
  "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
];

export function withoutSignIn(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !SIGN_IN_VARIABLES.includes(name)) kept[name] = value;
  return kept;
}
