export type IdToken = (audience: string | null) => Promise<string>;

export class NoIdToken extends Error {}
