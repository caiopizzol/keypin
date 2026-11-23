import { describe, expect, test } from "vite-plus/test";
import { SignInFailed } from "@keypin/core";
import { defaultAccount, withDefaultAccount } from "../../src/onepassword/index";

const HOME = "/home/me";
const ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const config = (body: Record<string, unknown>) => (path: string) =>
  path === `${HOME}/.config/op/config` ? JSON.stringify(body) : null;

describe("the default 1Password account, for a provider that names none", () => {
  test("OP_ACCOUNT comes first, as for the 1Password CLI", () => {
    expect(defaultAccount({ OP_ACCOUNT: " acme " }, config({}), HOME)).toBe("acme");
  });

  test("then the account the 1Password app signed the CLI in to last", () => {
    const read = config({ latest_signin: "", system_auth_latest_signin: ID, accounts: [] });
    expect(defaultAccount({}, read, HOME)).toBe(ID);
  });

  test("then the CLI's last sign-in, by its account ID", () => {
    const read = config({
      latest_signin: "my",
      accounts: [
        { shorthand: "other", accountUUID: "X" },
        { shorthand: "my", accountUUID: ID },
      ],
    });
    expect(defaultAccount({}, read, HOME)).toBe(ID);
  });

  test("OP_CONFIG_DIR moves the config, and no config means no account", () => {
    const read = (path: string) =>
      path === "/etc/op/config" ? JSON.stringify({ system_auth_latest_signin: ID }) : null;
    expect(defaultAccount({ OP_CONFIG_DIR: "/etc/op" }, read, HOME)).toBe(ID);
    expect(defaultAccount({}, () => null, HOME)).toBeNull();
    expect(defaultAccount({}, () => "not json", HOME)).toBeNull();
  });

  test("an account in the URI is used as it is, and no account anywhere can't sign in", async () => {
    const asked: string[] = [];
    const connect = withDefaultAccount(
      async (account) => {
        asked.push(account);
        throw new Error("stop");
      },
      () => null,
    );
    await expect(connect("my.1password.com")).rejects.toThrow("stop");
    expect(asked).toEqual(["my.1password.com"]);
    const refused = connect("").catch((error: unknown) => error);
    expect(await refused).toBeInstanceOf(SignInFailed);
    expect(await refused).toMatchObject({ reason: { kind: "unknown-account" } });
    expect(asked).toEqual(["my.1password.com"]);
  });

  test("an empty account signs in to the default one", async () => {
    const asked: string[] = [];
    const connect = withDefaultAccount(
      async (account) => {
        asked.push(account);
        throw new Error("stop");
      },
      () => ID,
    );
    await expect(connect("")).rejects.toThrow("stop");
    expect(asked).toEqual([ID]);
  });
});
