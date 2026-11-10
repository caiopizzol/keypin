import type { Launch, OnSignals } from "./deps";

export const launch: Launch = (command, env) => {
  const child = Bun.spawn(command, { env, stdio: ["inherit", "inherit", "inherit"] });
  return { exited: child.exited, kill: (signal) => child.kill(signal) };
};

export const onSignals: OnSignals = (handler) => {
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
};
