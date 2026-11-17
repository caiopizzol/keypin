import { createCipheriv, createDecipheriv, createHmac, hkdfSync, pbkdf2Sync } from "node:crypto";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  accessTokenKey,
  decrypt,
  decryptBytes,
  encrypt,
  encryptBytes,
  keyBytes,
  keyFrom,
} from "../../src/bitwarden/crypto";
import { accessTokenFrom } from "../../src/bitwarden/backend";

const CLIENTS = "https://github.com/bitwarden/clients/blob";
const CLIENTS_VECTOR_SOURCE = `${CLIENTS}/5461fdc587fcb5208b91eec111c676a54a579459/libs/importer/src/importers/spec-data/bitwarden-json/account-encrypted-v1.json.ts#L13-L54`;
const CLIENTS_HKDF_SOURCE = `${CLIENTS}/5461fdc587fcb5208b91eec111c676a54a579459/libs/legacy-crypto/src/node/node-crypto-function.service.spec.ts#L63-L83`;
const CLIENTS_AES_SOURCE = `${CLIENTS}/f9dff532a62f40f05a1054f75ea49e7737b0ae8a/libs/node/src/services/node-crypto-function.service.spec.ts#L180-L188`;
const SERVER_ACCESS_TOKEN_SOURCE =
  "https://github.com/bitwarden/server/blob/dd827fd9d56e59d4e29e826a818b4f631500668f/util/RustSdk/rust/src/sm_access_token.rs#L15-L19";

const ACCOUNT = {
  email: "test@bitwarden.com",
  password: "asdfasdfasdf",
  iterations: 600000,
  userKey:
    "2.Q/2PhzcC7GdeiMHhWguYAQ==|GpqzVdr0go0ug5cZh1n+uixeBC3oC90CIe0hd/HWA/pTRDZ8ane4fmsEIcuc8eMKUt55Y2q/fbNzsYu41YTZzzsJUSeqVjT8/iTQtgnNdpo=|dwI+uyvZ1h/iZ03VQ+/wrGEFYVewBUUl/syYgjsNMbE=",
  folder: [
    "2.uoB/y3k8KI8eIyhuI0Ik3A==|L+ppOwOYhdHMvYq9Pmg6sA==|nklVfeK8N3eAwIZtoixC2dxHsjoVCF8iWgy/2LvDN7k=",
    "Important",
  ],
  cipherKey:
    "2.zKyspm5JKcjnbAUF0uqXZg==|+Us0kRbeT0y6d0BHZJe/oa7/RmRpIBXuKcYKeJjzkC9BAxHPsuEk1Ts0yA879tDN859fPoy+y/lUdmXL7hXSYK9AVJ+p9RTvigDM/+9LN/8=|spylBx6kToTwQKvtH0GDiochMwp5sqh64cUbpS1jjUQ=",
  cipher: [
    [
      "2.W4t6HkuZJ6rIUiMW8xg2pA==|ygAmf2xUXbDpO+JfbHE6+Q==|JDBTbF6hJi/iQMpUQoxmuSDbrLlNllMukOfv0tswuGQ=",
      "Bitwarden",
    ],
    [
      "2.mqcWQeZXgglWrEJVaBfiAA==|eWTzm7B5+TDzphzoLWC42Q==|utQFK12gNNo3QAfkeCeNJkRoTyak6CEjCp7G6PuwOOo=",
      "My note",
    ],
  ],
} as const;

const TOKEN_ID = "5b0e3c7a-1f2d-4e6a-9b8c-7d6e5f4a3b2c";
const TOKEN_SEED = Buffer.from("keypin test seed").toString("base64");
const TOKEN = `0.${TOKEN_ID}.made-up-machine-secret:${TOKEN_SEED}`;

const staticBytes = (length: number) => Buffer.from(Array.from({ length }, (_, i) => i));

function hkdfExpand(prk: Buffer, info: string): Buffer {
  return createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
}

function referenceTokenKey(seed: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", seed, "bitwarden-accesstoken", "sm-access-token", 64));
}

function referenceSeal(plain: Buffer, key: Buffer, iv: Buffer): string {
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac("sha256", key.subarray(32))
    .update(Buffer.concat([iv, data]))
    .digest();
  return `2.${[iv, data, mac].map((part) => part.toString("base64")).join("|")}`;
}

function referenceOpen(sealed: string, key: Buffer): Buffer {
  const [type, iv = "", data = "", mac = ""] = sealed.split(/[.|]/);
  const [ivBytes, dataBytes] = [Buffer.from(iv, "base64"), Buffer.from(data, "base64")];
  expect(type).toBe("2");
  expect(
    createHmac("sha256", key.subarray(32))
      .update(Buffer.concat([ivBytes, dataBytes]))
      .digest()
      .toString("base64"),
  ).toBe(mac);
  const decipher = createDecipheriv("aes-256-cbc", key.subarray(0, 32), ivBytes);
  return Buffer.concat([decipher.update(dataBytes), decipher.final()]);
}

describe(`Bitwarden's type 2 strings, against the clients' export vectors (${CLIENTS_VECTOR_SOURCE})`, () => {
  test(`the test's own HKDF matches the clients' vectors (${CLIENTS_HKDF_SOURCE})`, () => {
    const ikm = Buffer.from("criAmKtfzxanbgea5/kelQ==", "base64");
    expect(Buffer.from(hkdfSync("sha256", ikm, "salt", "info", 32)).toString("base64")).toBe(
      "qBUmEYtwTwwGPuw/z6bs/qYXXYNUlocFlyAuuANI8Pw=",
    );
    const prk = Buffer.from("F5h4KdYQnIVH4rKH0P9CZb1GrR4n16/sJrS0PsQEn0Y=", "base64");
    expect(hkdfExpand(prk, "info").toString("base64")).toBe(
      "BnIqJlfnHm0e/2iB/15cbHyR19ARPIcWRp4oNS22CD8=",
    );
  });

  test("the account's stretched password opens its user key, which opens a cipher key, which opens the item", () => {
    const master = pbkdf2Sync(ACCOUNT.password, ACCOUNT.email, ACCOUNT.iterations, 32, "sha256");
    const stretched = keyFrom(
      Buffer.concat([hkdfExpand(master, "enc"), hkdfExpand(master, "mac")]),
    );
    assert(stretched);
    const userKey = keyFrom(decryptBytes(ACCOUNT.userKey, stretched) ?? Buffer.alloc(0));
    assert(userKey);
    const [folder, folderName] = ACCOUNT.folder;
    expect(decrypt(folder, userKey)).toBe(folderName);
    const cipherKey = keyFrom(decryptBytes(ACCOUNT.cipherKey, userKey) ?? Buffer.alloc(0));
    assert(cipherKey);
    for (const [sealed, plain] of ACCOUNT.cipher) expect(decrypt(sealed, cipherKey)).toBe(plain);
    expect(decrypt(folder, cipherKey)).toBeNull();
  });

  test(`what keypin encrypts matches the clients' AES-CBC vector and opens without keypin (${CLIENTS_AES_SOURCE})`, () => {
    const key = keyFrom(staticBytes(64));
    assert(key);
    const sealed = encryptBytes(Buffer.from("EncryptMe!"), key, staticBytes(16));
    expect(sealed.split("|")[1]).toBe("ByUF8vhyX4ddU9gcooznwA==");
    expect(referenceOpen(sealed, staticBytes(64)).toString("utf8")).toBe("EncryptMe!");
  });

  test("what keypin encrypts opens with the same key, and a changed byte doesn't", () => {
    const key = keyFrom(staticBytes(64));
    assert(key);
    const sealed = encrypt("a value with ünïcode", key);
    expect(decrypt(sealed, key)).toBe("a value with ünïcode");
    expect(referenceOpen(sealed, keyBytes(key)).toString("utf8")).toBe("a value with ünïcode");
    const [type, iv, data, mac] = sealed.split(/[.|]/);
    const flipped = `${type}.${iv}|${data?.replace(/^./, (c) => (c === "A" ? "B" : "A"))}|${mac}`;
    expect(decrypt(flipped, key)).toBeNull();
    expect(decrypt(`0.${iv}|${data}`, key)).toBeNull();
    expect(decrypt(`${type}.${iv}|${data}|${Buffer.alloc(32).toString("base64")}`, key)).toBeNull();
  });
});

describe(`An access token's key, against Node's HKDF with the constants in ${SERVER_ACCESS_TOKEN_SOURCE}`, () => {
  test.each([TOKEN_SEED, staticBytes(16).toString("base64"), "/////////////////////w=="])(
    "keypin derives the same key from seed %s",
    (seed) => {
      const key = accessTokenKey(Buffer.from(seed, "base64"));
      assert(key);
      expect(keyBytes(key).toString("base64")).toBe(
        referenceTokenKey(Buffer.from(seed, "base64")).toString("base64"),
      );
    },
  );

  test("a login payload sealed without keypin opens to the organization key, which opens a secret's name", () => {
    const organizationKey = Buffer.from(
      hkdfSync("sha256", Buffer.from("organization"), "", "", 64),
    );
    const payload = JSON.stringify({ encryptionKey: organizationKey.toString("base64") });
    const tokenKey = referenceTokenKey(Buffer.from(TOKEN_SEED, "base64"));
    const sealedPayload = referenceSeal(Buffer.from(payload), tokenKey, staticBytes(16));
    const sealedName = referenceSeal(Buffer.from("STRIPE_KEY"), organizationKey, staticBytes(16));

    const token = accessTokenFrom({ BWS_ACCESS_TOKEN: TOKEN });
    assert(token !== null && typeof token !== "string");
    const opened = decryptBytes(sealedPayload, token.key);
    assert(opened);
    const parsed: unknown = JSON.parse(opened.toString("utf8"));
    assert(typeof parsed === "object" && parsed !== null && "encryptionKey" in parsed);
    assert(typeof parsed.encryptionKey === "string");
    const key = keyFrom(Buffer.from(parsed.encryptionKey, "base64"));
    assert(key);
    expect(decrypt(sealedName, key)).toBe("STRIPE_KEY");
  });

  test.each([
    ["", "is empty", null],
    ["not-a-token", "has no parts", "isn't"],
    [`1.${TOKEN_ID}.secret:${TOKEN_SEED}`, "is another version", "isn't"],
    [`0.not-a-uuid.secret:${TOKEN_SEED}`, "has no ID", "isn't"],
    [`0.${TOKEN_ID}.secret:c2hvcnQ=`, "has a short key", "isn't"],
  ])("a token that %s is refused", (text, _, said) => {
    const token = accessTokenFrom({ BWS_ACCESS_TOKEN: text });
    if (said === null) expect(token).toBeNull();
    else expect(token).toContain(said);
  });
});
