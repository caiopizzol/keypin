import { signing } from "./sigv4";

const AUTH =
  /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/;

interface Signer {
  id: string;
  secret: string;
  token?: string;
  status?: "Active" | "Inactive";
}

type Verified<K> = { signer: K } | { refused: string; status: number; message: string };

export function verify<K extends Signer>(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  service: string,
  region: string,
  keys: readonly K[],
): Verified<K> {
  const auth = AUTH.exec(init.headers.Authorization ?? "");
  const date = init.headers["X-Amz-Date"] ?? "";
  if (!auth || auth[3] !== region || auth[4] !== service || auth[2] !== date.slice(0, 8))
    return {
      refused: "IncompleteSignature",
      status: 400,
      message: "the request isn't signed for this service",
    };
  const signer = keys.find((k) => k.id === auth[1]);
  const token = init.headers["X-Amz-Security-Token"];
  if (!signer || signer.status === "Inactive" || token !== signer.token)
    return {
      refused: "InvalidClientTokenId",
      status: 403,
      message: "The security token included in the request is invalid.",
    };
  const headers = Object.fromEntries(
    Object.entries(init.headers).filter(
      ([name]) =>
        !["authorization", "x-amz-date", "x-amz-security-token"].includes(name.toLowerCase()),
    ),
  );
  const expected = signing(
    { method: "POST", url, headers, body: init.body ?? "" },
    { id: signer.id, secret: signer.secret, ...(token === undefined ? {} : { token }) },
    { region, service },
    new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    ),
  );
  if (expected.signature !== auth[6])
    return {
      refused: "SignatureDoesNotMatch",
      status: 403,
      message: "The request signature we calculated does not match.",
    };
  return { signer };
}
