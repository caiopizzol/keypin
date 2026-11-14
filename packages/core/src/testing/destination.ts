import { expect, test } from "vite-plus/test";
import type { Destination } from "../contracts";
import { Secret } from "../secret";
import { caught, expectNoSentinel, SENTINEL } from "./leaks";

export interface DestinationSubject {
  destination: Destination;
  name: string;
  effects: readonly string[];
  received(name: string): string | undefined;
  refuse(): void;
  breakWrites(): void;
}

type Make = (sentinel: string) => DestinationSubject | Promise<DestinationSubject>;

export function destinationContract(make: Make): void {
  test("write rejects until checkAccount passes", async () => {
    const subject = await make(SENTINEL);
    const refused = await caught(subject.destination.write(subject.name, new Secret(SENTINEL)));
    expect(refused.message).toContain("checkAccount");
    expect(subject.effects).toEqual([]);
    expect(subject.received(subject.name)).toBeUndefined();

    expect((await subject.destination.checkAccount()).ok).toBe(true);
    const evidence = await subject.destination.write(subject.name, new Secret(SENTINEL));
    expect(subject.received(subject.name)).toBe(SENTINEL);
    expect(subject.effects).toHaveLength(1);
    expectNoSentinel(refused, evidence, subject.effects, subject.destination.describe());
  });

  test("a failed checkAccount after one that passed makes write reject again", async () => {
    const subject = await make(SENTINEL);
    expect((await subject.destination.checkAccount()).ok).toBe(true);
    subject.refuse();
    const check = await subject.destination.checkAccount();
    expect(check.ok).toBe(false);
    const refused = await caught(subject.destination.write(subject.name, new Secret(SENTINEL)));
    expect(refused.message).toContain("checkAccount");
    expect(subject.effects).toEqual([]);
    expectNoSentinel(check, refused);
  });

  test("a write the service refuses, even one that echoes the value, doesn't leak it", async () => {
    const subject = await make(SENTINEL);
    const check = await subject.destination.checkAccount();
    subject.breakWrites();
    const failed = await caught(subject.destination.write(subject.name, new Secret(SENTINEL)));
    expectNoSentinel(check, failed, subject.effects, subject.destination.describe());
  });
}
