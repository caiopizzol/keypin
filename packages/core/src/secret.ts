const HIDDEN = "[secret]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  equals(other: Secret): boolean {
    return this.#value === other.#value;
  }

  isEmpty(): boolean {
    return !this.#value;
  }

  includes(text: string): boolean {
    return this.#value.includes(text);
  }

  toString(): string {
    return HIDDEN;
  }

  toJSON(): string {
    return HIDDEN;
  }

  [Symbol.toPrimitive](): string {
    return HIDDEN;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return HIDDEN;
  }
}

export type Generation = string;

export async function generationOf(secret: Secret): Promise<Generation> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret.reveal()));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
