const ID = /_ID$/i;
const CREDENTIAL_ID = /(KEY|SECRET|TOKEN)_ID$/i;

export function looksLikeId(name: string): boolean {
  return ID.test(name) && !CREDENTIAL_ID.test(name);
}
