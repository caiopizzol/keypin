import { expect, test } from "vite-plus/test";
import { type Issuer, RevokeRefused } from "../contracts";
import type { Secret } from "../secret";
import { caught, expectNoSentinel, SENTINEL } from "./leaks";

export interface IssuerSubject {
  issuer: Issuer & Required<Pick<Issuer, "revoke">>;
  current: Secret;
  currentId?: string;
  vaultId: string;
  knowsVaultKey?: false;
  effects: readonly string[];
  failCreate(): void;
}

type Make = (sentinel: string) => IssuerSubject | Promise<IssuerSubject>;

const UNKNOWN = "never-issued";

export function issuerContract(make: Make): void {
  test("create and revoke reject until checkAccount passes", async () => {
    const { issuer, current, effects } = await make(SENTINEL);
    const create = await caught(issuer.create("API_KEY"));
    const revoke = await caught(issuer.revoke(UNKNOWN, current));
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
    await expect(issuer.revoke(UNKNOWN, current)).rejects.toThrow("checkAccount");
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
    const listed = await issuer.checkAccount(created.id, created.secret);
    expect(listed.ok).toBe(true);
    await issuer.checkAccount(currentId ?? null, current);
    expect(await issuer.revoke(created.id, current)).toBe("revoked");
    expect(await issuer.revoke(created.id, current)).toBe("already gone");
    expect(await issuer.revoke(UNKNOWN, current)).toBe("already gone");
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

  test("revoke refuses the key the vault holds, and changes nothing", async () => {
    const {
      issuer,
      current,
      currentId = null,
      vaultId,
      knowsVaultKey,
      effects,
    } = await make(SENTINEL);
    if (knowsVaultKey === false) return;
    expect((await issuer.checkAccount(currentId, current)).ok).toBe(true);
    await expect(issuer.revoke(vaultId, current)).rejects.toThrow(RevokeRefused);
    expect(effects).toEqual([]);
  });

  test("revoke deletes the retired key once the vault holds the new one", async () => {
    const { issuer, current, currentId, vaultId, effects } = await make(SENTINEL);
    expect((await issuer.checkAccount(currentId ?? null, current)).ok).toBe(true);
    const created = await issuer.create("API_KEY");
    expect((await issuer.checkAccount(created.id, created.secret)).ok).toBe(true);
    expect(await issuer.revoke(vaultId, created.secret)).toBe("revoked");
    expect(effects).toHaveLength(2);
  });

  test("has says whether an issued key is still there, whatever the vault holds", async () => {
    const { issuer, current, currentId, effects } = await make(SENTINEL);
    if (!issuer.has) return;
    expect((await issuer.checkAccount(currentId ?? null, current)).ok).toBe(true);
    const created = await issuer.create("API_KEY");
    expect(await issuer.has(created.id)).toBe(true);
    expect(await issuer.has(UNKNOWN)).toBe(false);
    expect(await issuer.revoke(created.id, current)).toBe("revoked");
    expect(await issuer.has(created.id)).toBe(false);
    expect(effects).toHaveLength(2);
  });

  test("a create the service refuses doesn't leak the admin key", async () => {
    const subject = await make(SENTINEL);
    await subject.issuer.checkAccount(subject.currentId ?? null, subject.current);
    subject.failCreate();
    const failed = await caught(subject.issuer.create("API_KEY"));
    expectNoSentinel(failed, subject.effects);
  });
}
