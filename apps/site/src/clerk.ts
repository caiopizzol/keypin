import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Auth } from "./signup";

export function clerkAuth(secretKey: string, siteOrigin: string): Auth {
  const clerk = createClerkClient({ secretKey });
  return {
    async verify(token) {
      try {
        const claims = await verifyToken(token, { secretKey, authorizedParties: [siteOrigin] });
        return claims.sub;
      } catch {
        return null;
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
