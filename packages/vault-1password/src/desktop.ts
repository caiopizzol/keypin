import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { type Connect, desktopConnect as sdkConnect } from "./sdk";

export const DESKTOP_APP_MISSING = "the 1Password desktop app isn't installed";

const LIBRARIES: Record<string, (home: string) => string[]> = {
  darwin: (home) => [
    "/Applications/1Password.app/Contents/Frameworks/libop_sdk_ipc_client.dylib",
    join(home, "Applications/1Password.app/Contents/Frameworks/libop_sdk_ipc_client.dylib"),
  ],
  linux: () => [
    "/usr/bin/1password/libop_sdk_ipc_client.so",
    "/opt/1Password/libop_sdk_ipc_client.so",
    "/snap/bin/1password/libop_sdk_ipc_client.so",
  ],
  win32: (home) => [
    join(home, "AppData/Local/1Password/op_sdk_ipc_client.dll"),
    "C:/Program Files/1Password/app/8/op_sdk_ipc_client.dll",
    "C:/Program Files (x86)/1Password/app/8/op_sdk_ipc_client.dll",
    join(home, "AppData/Local/1Password/app/8/op_sdk_ipc_client.dll"),
  ],
};

export function desktopLibrary(
  os: string = platform(),
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string | null {
  return (LIBRARIES[os]?.(home) ?? []).find(exists) ?? null;
}

export function requireDesktopApp(
  connect: Connect,
  found: () => string | null = desktopLibrary,
): Connect {
  return async (account) => {
    if (!found()) throw new Error(DESKTOP_APP_MISSING);
    return connect(account);
  };
}

export const desktopConnect: Connect = requireDesktopApp(sdkConnect);
