export type Fetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: "error";
    signal?: AbortSignal;
  },
) => Promise<Response>;
