import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface Key {
  readonly enc: Buffer;
  readonly mac: Buffer;
}

const KEY_BYTES = 64;
const SEED_BYTES = 16;
const IV_BYTES = 16;
const AES_CBC_HMAC = "2";
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function keyFrom(bytes: Uint8Array): Key | null {
  if (bytes.length !== KEY_BYTES) return null;
  const all = Buffer.from(bytes);
  return { enc: all.subarray(0, 32), mac: all.subarray(32) };
}

export function keyBytes(key: Key): Buffer {
  return Buffer.concat([key.enc, key.mac]);
}

export function accessTokenKey(seed: Uint8Array): Key | null {
  if (seed.length !== SEED_BYTES) return null;
  const prk = createHmac("sha256", "bitwarden-accesstoken").update(seed).digest();
  const info = Buffer.from("sm-access-token");
  const first = createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();
  const second = createHmac("sha256", prk)
    .update(Buffer.concat([first, info, Buffer.from([2])]))
    .digest();
  return keyFrom(Buffer.concat([first, second]));
}

function macOf(key: Key, iv: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key.mac)
    .update(Buffer.concat([iv, data]))
    .digest();
}

export function encryptBytes(plain: Uint8Array, key: Key, iv = randomBytes(IV_BYTES)): string {
  const cipher = createCipheriv("aes-256-cbc", key.enc, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const parts = [iv, data, macOf(key, iv, data)].map((part) => part.toString("base64"));
  return `${AES_CBC_HMAC}.${parts.join("|")}`;
}

export function encrypt(text: string, key: Key): string {
  return encryptBytes(Buffer.from(text, "utf8"), key);
}

export function decryptBytes(sealed: string, key: Key): Buffer | null {
  const dot = sealed.indexOf(".");
  if (sealed.slice(0, dot) !== AES_CBC_HMAC) return null;
  const parts = sealed
    .slice(dot + 1)
    .split("|")
    .map((part) => Buffer.from(part, "base64"));
  const [iv, data, mac] = parts;
  if (parts.length !== 3 || !iv || !data || !mac || iv.length !== IV_BYTES) return null;
  const expected = macOf(key, iv, data);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key.enc, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    return null;
  }
}

export function decrypt(sealed: string, key: Key): string | null {
  const bytes = decryptBytes(sealed, key);
  if (!bytes) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}
