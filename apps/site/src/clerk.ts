import { createClerkClient, verifyToken } from "@clerk/backend";
import { TokenVerificationError, TokenVerificationErrorReason } from "@clerk/backend/errors";
import type { Auth } from "./signup";

const OUR_SIDE: readonly string[] = [
  TokenVerificationErrorReason.InvalidSecretKey,
  TokenVerificationErrorReason.LocalJWKMissing,
  TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  TokenVerificationErrorReason.RemoteJWKInvalid,
  TokenVerificationErrorReason.RemoteJWKMissing,
  TokenVerificationErrorReason.JWKFailedToResolve,
];

export function isBadToken(error: unknown): boolean {
  return error instanceof TokenVerificationError && !OUR_SIDE.includes(error.reason);
}

export function clerkAuth(secretKey: string, siteOrigin: string): Auth {
  const clerk = createClerkClient({ secretKey });
  return {
    async verify(token) {
      try {
        const claims = await verifyToken(token, { secretKey, authorizedParties: [siteOrigin] });
        return claims.sub;
      } catch (error) {
        if (isBadToken(error)) return null;
        throw error;
      }
    },
    async profile(userId) {
      const user = await clerk.users.getUser(userId);
      const github = user.externalAccounts.find((account) => account.provider === "oauth_github");
      const email = user.primaryEmailAddress;
      return {
        githubLogin: github?.username ?? null,
        email: email?.verification?.status === "verified" ? email.emailAddress : null,
      };
    },
  };
}
