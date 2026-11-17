import { describe, expect, test } from "vite-plus/test";
import type { PlanStep, PublishTarget } from "@keypin/core";
import { publishRows } from "../src/publishing";
import { destinations } from "../src/start";

const NETLIFY_NOTE =
  "Netlify uses the new value only from the next build and deploy; redeploy to use it";
const VERCEL_NOTE = "Vercel uses the new value only in new deployments; redeploy to use it";

function netlify(context: string): PublishTarget {
  return { to: "netlify-project", account: "acme", team: "acme", project: "web", context };
}

function write(target: PublishTarget): PlanStep {
  return {
    action: "write",
    destinationId: `${target.to}:${target["context"] ?? target["environment"]}`,
    target,
    reason: "different generation",
    approval: null,
  };
}

const label = (target: PublishTarget) =>
  `${target.to} ${target["context"] ?? target["environment"]}`;

describe("plan rows", () => {
  test("a destination kind's note shows once, under its last write", () => {
    const vercel: PublishTarget = {
      to: "vercel-project",
      account: "acme",
      team: "acme",
      project: "web",
      environment: "production",
    };
    const steps = [
      write(netlify("production")),
      write(vercel),
      write(netlify("deploy-preview")),
      write(netlify("branch-deploy")),
    ];
    expect(publishRows(steps, label, destinations).map((row) => row.detail)).toEqual([
      null,
      VERCEL_NOTE,
      null,
      NETLIFY_NOTE,
    ]);
  });

  test("a destination that already has the value gets no note", () => {
    const skipped: PlanStep = {
      action: "skip",
      destinationId: "netlify-project:branch-deploy",
      target: netlify("branch-deploy"),
      reason: "receipt already has this generation",
      approval: null,
    };
    const rows = publishRows([write(netlify("production")), skipped], label, destinations);
    expect(rows.map((row) => row.detail)).toEqual([NETLIFY_NOTE, null]);
  });
});
