import { TokenVerificationError, TokenVerificationErrorReason } from "@clerk/backend/errors";
import { describe, expect, test } from "vite-plus/test";
import { isBadToken } from "../src/clerk";

const failure = (reason: TokenVerificationErrorReason) =>
  new TokenVerificationError({ reason, message: reason });

describe("isBadToken", () => {
  test.each([
    TokenVerificationErrorReason.TokenExpired,
    TokenVerificationErrorReason.TokenInvalidSignature,
    TokenVerificationErrorReason.TokenInvalidAuthorizedParties,
    TokenVerificationErrorReason.JWKKidMismatch,
  ])("%s is the caller's bad token, so 401", (reason) => {
    expect(isBadToken(failure(reason))).toBe(true);
  });

  test.each([
    TokenVerificationErrorReason.RemoteJWKFailedToLoad,
    TokenVerificationErrorReason.InvalidSecretKey,
    TokenVerificationErrorReason.JWKFailedToResolve,
  ])("%s is our side failing, so 500", (reason) => {
    expect(isBadToken(failure(reason))).toBe(false);
  });

  test("any other error is ours, so 500", () => {
    expect(isBadToken(new Error("fetch failed"))).toBe(false);
  });
});
