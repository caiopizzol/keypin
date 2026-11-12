import { API_PATHS, handleApi } from "./api";
import { clerkAuth } from "./clerk";
import { type D1, d1Store } from "./store";

const SITE = "keypin.dev";

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  SITE_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const www = url.hostname === `www.${SITE}`;
    if (www || (url.hostname === SITE && url.protocol !== "https:")) {
      url.hostname = SITE;
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    if (API_PATHS.includes(url.pathname)) {
      return handleApi(request, {
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
        siteOrigin: env.SITE_ORIGIN,
        auth: clerkAuth(env.CLERK_SECRET_KEY, env.SITE_ORIGIN),
        store: d1Store(env.DB),
        now: () => new Date().toISOString(),
        log: (message, cause) => console.error(message, cause),
      });
    }
    return env.ASSETS.fetch(request);
  },
};
