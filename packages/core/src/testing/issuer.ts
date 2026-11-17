import { expect, test } from "vite-plus/test";
import type { Issuer } from "../contracts";
import type { Secret } from "../secret";
import { caught, expectNoSentinel, SENTINEL } from "./leaks";

export interface IssuerSubject {
  issuer: Issuer;
  current: Secret;
  currentId?: string;
  effects: readonly string[];
  failCreate(): void;
}

type Make = (sentinel: string) => IssuerSubject | Promise<IssuerSubject>;

const UNKNOWN = "never-issued";

export function issuerContract(make: Make): void {
  test("create and revoke reject until checkAccount passes", async () => {
    const { issuer, effects } = await make(SENTINEL);
    const create = await caught(issuer.create("API_KEY"));
    const revoke = await caught(issuer.revoke(UNKNOWN));
    expect(create.message).toContain("checkAccount");
    expect(revoke.message).toContain("checkAccount");
    expect(effects).toEqual([]);
    expectNoSentinel(create, revoke);
  });

  test("checkAccount fails for an id the account doesn't list, and create then rejects", async () => {
    const { issuer, current, currentId = null, effects } = await make(SENTINEL);
    expect((await issuer.checkAccount(currentId, current)).ok).toBe(true);
    const check = await issuer.checkAccount(UNKNOWN, current);
    expect(check.ok).toBe(false);
    await expect(issuer.create("API_KEY")).rejects.toThrow("checkAccount");
    await expect(issuer.revoke(UNKNOWN)).rejects.toThrow("checkAccount");
    expect(effects).toEqual([]);
    expectNoSentinel(check);
  });

  test("an issued key is listed until revoked, and revoking it again is already gone", async () => {
    const { issuer, current, currentId, effects } = await make(SENTINEL);
    const first = await issuer.checkAccount(currentId ?? null, current);
    expect(first.ok).toBe(true);
    const created = await issuer.create("API_KEY");
    expect(created.secret.includes(SENTINEL)).toBe(true);
    const pairedWith = currentId === undefined ? current : created.secret;
    const listed = await issuer.checkAccount(created.id, pairedWith);
    expect(listed.ok).toBe(true);
    expect(await issuer.revoke(created.id)).toBe("revoked");
    expect(await issuer.revoke(created.id)).toBe("already gone");
    expect(await issuer.revoke(UNKNOWN)).toBe("already gone");
    expect((await issuer.checkAccount(created.id, pairedWith)).ok).toBe(false);
    expect(effects).toHaveLength(2);
    expectNoSentinel(
      first,
      listed,
      created.id,
      created,
      effects,
      issuer.describe(),
      issuer.dashboard(),
    );
  });

  test("a create the service refuses doesn't leak the admin key", async () => {
    const subject = await make(SENTINEL);
    await subject.issuer.checkAccount(subject.currentId ?? null, subject.current);
    subject.failCreate();
    const failed = await caught(subject.issuer.create("API_KEY"));
    expectNoSentinel(failed, subject.effects);
  });
}
