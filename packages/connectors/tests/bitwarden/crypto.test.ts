import { assert, describe, expect, test } from "vite-plus/test";
import {
  accessTokenKey,
  decrypt,
  decryptBytes,
  encrypt,
  keyBytes,
  keyFrom,
} from "../../src/bitwarden/crypto";
import { accessTokenFrom } from "../../src/bitwarden/backend";

const TOKEN =
  "0.ec2c1d46-6a4b-4751-a310-af9601317f2d.C2IgxjjLF7qSshsbwe8JGcbM075YXw:X8vbvA0bduihIDe/qrzIQQ==";
const PAYLOAD =
  "2.E9fE8+M/VWMfhhim1KlCbQ==|eLsHR484S/tJbIkM6spnG/HP65tj9A6Tba7kAAvUp+rYuQmGLixiOCfMsqt5OvBctDfvvr/AesBu7cZimPLyOEhqEAjn52jF0eaI38XZfeOG2VJl0LOf60Wkfh3ryAMvfvLj3G4ZCNYU8sNgoC2+IQ==|lNApuCQ4Pyakfo/wwuuajWNaEX/2MW8/3rjXB/V7n+k=";
const NAMES = [
  [
    "2.pMS6/icTQABtulw52pq2lg==|XXbxKxDTh+mWiN1HjH2N1w==|Q6PkuT+KX/axrgN9ubD5Ajk2YNwxQkgs3WJM0S0wtG8=",
    "TEST",
  ],
  [
    "2.WYqmVCB2wZc08tkzNOCmTw==|FAsVol/nJnnDk3/mp7z6QQ==|uPJOCC8iAbMzz4t60c35iZm8KzWKMn0ueCVJZlfmTdY=",
    "btw",
  ],
];

function organizationKey() {
  const token = accessTokenFrom({ BWS_ACCESS_TOKEN: TOKEN });
  assert(token !== null && typeof token !== "string");
  const opened = decryptBytes(PAYLOAD, token.key);
  assert(opened);
  const parsed: unknown = JSON.parse(opened.toString("utf8"));
  assert(typeof parsed === "object" && parsed !== null && "encryptionKey" in parsed);
  assert(typeof parsed.encryptionKey === "string");
  const key = keyFrom(Buffer.from(parsed.encryptionKey, "base64"));
  assert(key);
  return key;
}

describe("Bitwarden's client-side encryption, against the SDK's own vectors", () => {
  test("an access token's key matches the SDK's known answer", () => {
    const key = accessTokenKey(Buffer.from("X8vbvA0bduihIDe/qrzIQQ==", "base64"));
    assert(key);
    expect(keyBytes(key).toString("base64")).toBe(
      "H9/oIRLtL9nGCQOVDjSMoEbJsjWXSOCb3qeyDt6ckzS3FhyboEDWyTP/CQfbIszNmAVg2ExFganG1FVFGXO/Jg==",
    );
  });

  test("the login payload opens to the organization key, which opens the SDK's fake secrets", () => {
    const key = organizationKey();
    for (const [sealed = "", name] of NAMES) expect(decrypt(sealed, key)).toBe(name);
  });

  test("what keypin encrypts opens with the same key, and a changed byte doesn't", () => {
    const key = organizationKey();
    const sealed = encrypt("a value with ünïcode", key);
    expect(decrypt(sealed, key)).toBe("a value with ünïcode");
    const [type, iv, data, mac] = sealed.split(/[.|]/);
    const flipped = `${type}.${iv}|${data?.replace(/^./, (c) => (c === "A" ? "B" : "A"))}|${mac}`;
    expect(decrypt(flipped, key)).toBeNull();
    expect(decrypt(`0.${iv}|${data}`, key)).toBeNull();
  });

  test.each([
    ["", "is empty", null],
    ["not-a-token", "has no parts", "isn't"],
    [
      "1.ec2c1d46-6a4b-4751-a310-af9601317f2d.secret:X8vbvA0bduihIDe/qrzIQQ==",
      "is another version",
      "isn't",
    ],
    ["0.not-a-uuid.secret:X8vbvA0bduihIDe/qrzIQQ==", "has no ID", "isn't"],
    ["0.ec2c1d46-6a4b-4751-a310-af9601317f2d.secret:c2hvcnQ=", "has a short key", "isn't"],
  ])("a token that %s is refused", (text, _, said) => {
    const token = accessTokenFrom({ BWS_ACCESS_TOKEN: text });
    if (said === null) expect(token).toBeNull();
    else expect(token).toContain(said);
  });
});
