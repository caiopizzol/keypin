import {
  type IssuedKey,
  type Issuer,
  type IssuerCheck,
  type IssuerKind,
  Secret,
} from "@keypin/core";

const BYTES = 32;
const ENCODINGS = ["base64", "hex"] as const;
type Encoding = (typeof ENCODINGS)[number];
const DOCS = "docs/configuration.md#random";
const BETTER_AUTH = ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS"];
const BETTER_AUTH_DOCS = "https://better-auth.com/docs/reference/options#secrets";

export interface RandomSpec {
  readonly kind: "random";
  readonly encoding: Encoding;
}

export const randomIssuer: IssuerKind<RandomSpec> = {
  kind: "random",
  admin: false,
  parse(read) {
    read.only(["encoding"]);
    const given = read.optional("encoding");
    const encoding = given === undefined ? "base64" : ENCODINGS.find((known) => known === given);
    if (encoding === undefined) {
      read.fail(`field "encoding" must be one of: ${ENCODINGS.join(", ")}`);
      return undefined;
    }
    return { kind: "random", encoding };
  },
  refuses: (keyName) =>
    BETTER_AUTH.includes(keyName)
      ? `Better Auth encrypts two-factor secrets and OAuth tokens with it, and a new value can't read them. Add a version to BETTER_AUTH_SECRETS by hand instead: ${BETTER_AUTH_DOCS}`
      : undefined,
  connect: ({ encoding }) => new RandomIssuer(encoding),
};

export class RandomIssuer implements Issuer {
  readonly #encoding: Encoding;

  constructor(encoding: Encoding) {
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
