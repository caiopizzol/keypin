import { describe, expect, test } from "vite-plus/test";
import { envFileKind, envNames, envValues } from "../src/index";

const SENTINEL = "sentinel-value-7f3a9c2e1d";

describe("env files", () => {
  test("names the files that set keys and the ones that only list them", () => {
    expect(envFileKind(".env")).toBe("set");
    expect(envFileKind(".env.local")).toBe("set");
    expect(envFileKind(".dev.vars")).toBe("set");
    expect(envFileKind(".dev.vars.staging")).toBe("set");
    expect(envFileKind(".env.example")).toBe("expected");
    expect(envFileKind(".dev.vars.sample")).toBe("expected");
    expect(envFileKind(".env.template")).toBe("expected");
    expect(envFileKind(".envrc")).toBeNull();
    expect(envFileKind("env")).toBeNull();
    expect(envFileKind("wrangler.toml")).toBeNull();
  });

  test("reads names only, including export lines, and skips multi-line values", () => {
    const text = [
      "# A_COMMENT=nope",
      `API_KEY=${SENTINEL}`,
      `export TOKEN="${SENTINEL}"`,
      "  SPACED = x",
      `PEM="-----BEGIN-----`,
      `NOT_A_NAME=${SENTINEL}`,
      `-----END-----"`,
      "EMPTY=",
      "lower_case=1",
      "1BAD=2",
      "no equals sign",
      `API_KEY=${SENTINEL}`,
    ].join("\n");
    const names = envNames(text);
    expect(names).toEqual(["API_KEY", "TOKEN", "SPACED", "PEM", "EMPTY", "lower_case", "1BAD"]);
    expect(JSON.stringify(names)).not.toContain(SENTINEL);
  });

  test("an escaped quote doesn't end a single-quoted or backtick value", () => {
    expect(envNames(`A='it\\'s\nLEAK_${SENTINEL}=x\nend'\nB=1`)).toEqual(["A", "B"]);
    expect(envNames("A=`x\\`\nLEAK2=y\n`\nB=1")).toEqual(["A", "B"]);
  });

  test("lines of a multi-line value that end in base64 padding aren't names", () => {
    const text = [
      `CERT="MIIBIjANBgkqhkiG9w0BAQEFAAOC`,
      `QWxhZGRpbjpvcGVuIHNlc2FtZQ==`,
      `U0VOVElORUxWQUxVRQ=`,
      `"`,
      "NEXT=1",
    ].join("\n");
    expect(envNames(text)).toEqual(["CERT", "NEXT"]);
  });

  test("keys dotenv accepts, dotted, dashed or with a colon, open multi-line values too", () => {
    const text = [
      `app.key="first line`,
      `HIDDEN${SENTINEL}=value`,
      `"`,
      "my-key: plain",
      "AFTER=1",
    ].join("\n");
    const names = envNames(text);
    expect(names).toEqual(["app.key", "my-key", "AFTER"]);
    expect(JSON.stringify(names)).not.toContain(SENTINEL);
  });
});

describe("env values", () => {
  test("reads each value as dotenv does, inside a Secret", () => {
    const text = [
      "PLAIN= plain value  # a comment",
      `export SINGLE='it is "quoted"'`,
      `DOUBLE="line one\\nline two"`,
      'MULTI="first',
      'second"',
      "EMPTY=",
      "COLON: value",
      "",
    ].join("\r\n");
    const values = envValues(text);
    expect(Object.fromEntries([...values].map(([name, value]) => [name, value.reveal()]))).toEqual({
      PLAIN: "plain value",
      SINGLE: 'it is "quoted"',
      DOUBLE: "line one\nline two",
      MULTI: "first\nsecond",
      EMPTY: "",
      COLON: "value",
    });
    expect(JSON.stringify([...values])).not.toContain("plain value");
  });

  test("the last line for a name wins, and names keep their first place", () => {
    const values = envValues(`A=${SENTINEL}\nB=2\nA=3\n`);
    expect([...values.keys()]).toEqual(["A", "B"]);
    expect(values.get("A")?.reveal()).toBe("3");
  });
});
