const ID = /_(ACCOUNT|PROJECT|ORG|ORGANIZATION|TEAM|ZONE)_ID$/i;

export function looksLikeId(name: string): boolean {
  return ID.test(name);
}
