import { type IssuedKey, type Issuer, type IssuerCheck, Secret } from "@keypin/core";

const BYTES = 32;
const DOCS = "docs/rotation.md#random";

export class RandomIssuer implements Issuer {
  readonly #encoding: "base64" | "hex";

  constructor(encoding: "base64" | "hex") {
    this.#encoding = encoding;
  }

  describe(): string {
    return "random";
  }

  dashboard(): string {
    return DOCS;
  }

  async checkAccount(): Promise<IssuerCheck> {
    return {
      ok: true,
      facts: `${BYTES} random bytes, ${this.#encoding}`,
      notes: {
        create:
          "replaces the old value: anything signed with it stops working, so everyone signs in again. Don't use it for Better Auth, which also reads AUTH_SECRET: its stored two-factor secrets would become unreadable",
      },
    };
  }

  async create(name: string): Promise<IssuedKey> {
    const bytes = Buffer.from(crypto.getRandomValues(new Uint8Array(BYTES)));
    return { id: name, secret: new Secret(bytes.toString(this.#encoding)) };
  }
}
