import { describe, expect, test } from "vite-plus/test";
import { saveCommands } from "../src/commands/check/missing";

const file = (path: string, names = ["RESEND_API_KEY"]) => ({
  path,
  kind: "set" as const,
  names,
  tracked: false,
});
const production = [{ key: "RESEND_API_KEY", environment: "production" }];

describe("saveCommands", () => {
  test("imports only a file named for the profile", () => {
    expect(saveCommands(production, [file(".env"), file(".env.production")])).toEqual([
      "Each profile has its own items. Save the production value from .env.production:",
      "  SECRETSPEC_PROFILE=production secretspec import dotenv:.env.production",
    ]);
  });

  test("a file named for another profile, or plain .env, gets the one-key command", () => {
    const set = [
      "Each profile has its own items. Save the production value:",
      "  secretspec set RESEND_API_KEY --profile production",
    ];
    expect(saveCommands(production, [file(".env.staging")])).toEqual(set);
    expect(saveCommands(production, [file(".env")])).toEqual(set);
    const staging = [{ key: "RESEND_API_KEY", environment: "staging" }];
    expect(saveCommands(staging, [file(".env.staging")])[1]).toBe(
      "  SECRETSPEC_PROFILE=staging secretspec import dotenv:.env.staging",
    );
  });

  test("quotes a path with spaces or shell characters as one argument", () => {
    expect(saveCommands(production, [file("web app/.env.production")])[1]).toBe(
      "  SECRETSPEC_PROFILE=production secretspec import 'dotenv:web app/.env.production'",
    );
    expect(saveCommands(production, [file("it's$HOME/.env.production")])[1]).toBe(
      "  SECRETSPEC_PROFILE=production secretspec import 'dotenv:it'\\''s$HOME/.env.production'",
    );
  });
});
