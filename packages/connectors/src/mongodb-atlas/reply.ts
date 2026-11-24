export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export function failure(
  method: string,
  path: string,
  reply: Reply,
  type: new (message: string) => Error = Error,
): Error {
  return new type(`Atlas ${method} ${path} returned HTTP ${reply.status}${codeOf(reply)}`);
}

export function codeOf(reply: Reply): string {
  const code = reply.body.errorCode;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? ` ${code}` : "";
}
