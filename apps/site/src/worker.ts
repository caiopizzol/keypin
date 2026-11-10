const SITE = "keypin.dev";

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
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
    return env.ASSETS.fetch(request);
  },
};
