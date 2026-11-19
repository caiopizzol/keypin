import { assert, describe, expect, test } from "vite-plus/test";
import { workflowRefs } from "../../src/github/index";

describe("workflows", () => {
  test("finds secrets and vars in expressions and if conditions, not in comments", () => {
    const refs = workflowRefs(`
on: push
jobs:
  deploy:
    if: secrets.DEPLOY_ON != ''
    environment: production
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ secrets.API_TOKEN }} \${{ vars.REGION }}"
        env:
          # OLD: \${{ secrets.COMMENTED_OUT }}
          KEY: \${{ secrets['BRACKET_KEY'] }}
          GH: \${{ secrets.GITHUB_TOKEN }}
          lower: \${{ secrets.lower_name }}
`);
    assert(refs);
    expect(refs.secrets.toSorted()).toEqual([
      "API_TOKEN",
      "BRACKET_KEY",
      "DEPLOY_ON",
      "GITHUB_TOKEN",
      "LOWER_NAME",
    ]);
    expect(refs.vars).toEqual(["REGION"]);
    expect(refs.environments).toEqual(["production"]);
    expect(refs.hidesUses).toBe(false);
  });

  test("keeps which secrets each job uses with the environment it declares", () => {
    const refs = workflowRefs(`
on: push
env:
  TOP: \${{ secrets.TOP_LEVEL }}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.TEST_TOKEN }}
  deploy:
    environment:
      name: production
      url: https://example.com
    steps:
      - run: echo \${{ secrets.API_TOKEN }}
  preview:
    environment: \${{ github.ref_name }}
    steps:
      - run: echo \${{ secrets.PREVIEW_TOKEN }}
`);
    assert(refs);
    expect(refs.uses).toEqual([
      { environment: null, secrets: ["TOP_LEVEL"], fromCaller: false },
      { environment: null, secrets: ["TEST_TOKEN"], fromCaller: false },
      { environment: "production", secrets: ["API_TOKEN"], fromCaller: false },
      { environment: "${{ github.ref_name }}", secrets: ["PREVIEW_TOKEN"], fromCaller: false },
    ]);
    expect(refs.secrets.toSorted()).toEqual([
      "API_TOKEN",
      "PREVIEW_TOKEN",
      "TEST_TOKEN",
      "TOP_LEVEL",
    ]);
  });

  test("notices secrets: inherit and toJSON(secrets), which can hide uses", () => {
    expect(
      workflowRefs(`
jobs:
  call:
    uses: ./.github/workflows/deploy.yml
    secrets: inherit
`)?.hidesUses,
    ).toBe(true);
    expect(
      workflowRefs("jobs:\n  a:\n    steps:\n      - run: echo '${{ toJSON(secrets) }}'\n")
        ?.hidesUses,
    ).toBe(true);
  });

  test("a workflow only other workflows call reads its caller's secrets, declared or inherited", () => {
    for (const on of [
      "on: workflow_call",
      "on: [workflow_call]",
      "on:\n  workflow_call:\n    secrets:\n      deploy_key:\n        required: true",
    ]) {
      const refs = workflowRefs(`
${on}
env:
  TOP: \${{ secrets.TOP_TOKEN }}
jobs:
  deploy:
    steps:
      - run: echo \${{ secrets.DEPLOY_KEY }} \${{ secrets.SENTRY_TOKEN }}
`);
      expect(refs).toMatchObject({ secrets: [], uses: [], hidesUses: false });
    }
  });

  test("a called workflow's job with an environment keeps its secrets, marked as passed by the caller", () => {
    const refs = workflowRefs(`
on:
  workflow_call:
    secrets:
      DEPLOY_KEY:
        required: true
jobs:
  test:
    steps:
      - run: echo \${{ secrets.DEPLOY_KEY }}
  deploy:
    environment: production
    steps:
      - run: echo \${{ secrets.DEPLOY_KEY }}
`);
    expect(refs?.uses).toEqual([
      { environment: "production", secrets: ["DEPLOY_KEY"], fromCaller: true },
    ]);
  });

  test("a workflow also run by other events still needs its declared secrets from the repo", () => {
    const refs = workflowRefs(`
on:
  workflow_dispatch:
  workflow_call:
    secrets:
      DEPLOY_KEY: {}
jobs:
  deploy:
    steps:
      - run: echo \${{ secrets.DEPLOY_KEY }}
`);
    expect(refs).toMatchObject({ secrets: ["DEPLOY_KEY"] });
  });

  test("a secret picked by an expression hides which one is used", () => {
    for (const index of ["matrix.name", "format('{0}_KEY', matrix.env)", "'A' && 'B'", "env.NAME"])
      expect(
        workflowRefs(`jobs:\n  a:\n    steps:\n      - run: echo '\${{ secrets[${index}] }}'\n`)
          ?.hidesUses,
      ).toBe(true);
    expect(
      workflowRefs("jobs:\n  a:\n    steps:\n      - run: echo ${{ secrets[ 'KEY' ] }}\n"),
    ).toMatchObject({ secrets: ["KEY"], hidesUses: false });
  });

  test("matches toJSON(secrets) and context names in any case, as GitHub does", () => {
    for (const call of ["tojson(secrets)", "TOJSON( secrets )", "toJSON(Secrets)"]) {
      expect(
        workflowRefs(`jobs:\n  a:\n    steps:\n      - run: echo '\${{ ${call} }}'\n`)?.hidesUses,
      ).toBe(true);
    }
    const refs = workflowRefs(
      "jobs:\n  a:\n    steps:\n      - run: echo ${{ Secrets.API_TOKEN }} ${{ SECRETS['KEY'] }} ${{ VARS.REGION }}\n",
    );
    expect(refs).toMatchObject({ secrets: ["API_TOKEN", "KEY"], vars: ["REGION"] });
  });

  test("an alias that refers to itself is read once instead of recursing forever", () => {
    const refs = workflowRefs(
      "loop: &x\n  again: *x\njobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n",
    );
    expect(refs).toMatchObject({ secrets: ["TOKEN"], hidesUses: false });
  });

  test("strings inside an expression neither end it nor count as references", () => {
    const refs = workflowRefs(`
jobs:
  a:
    if: "'secrets.IN_IF' != secrets.REAL_IF"
    steps:
      - run: "\${{ format('{{\\"t\\":\\"{0}\\"}}', secrets.API_TOKEN) }}"
      - run: "\${{ 'secrets.MISSING' }} \${{ 'it''s' }} \${{ secrets['QUOTED'] }}"
`);
    assert(refs);
    expect(refs.secrets.toSorted()).toEqual(["API_TOKEN", "QUOTED", "REAL_IF"]);
  });

  test("reads a workflow saved with a byte order mark", () => {
    const refs = workflowRefs(
      "\uFEFFjobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n",
    );
    assert(refs);
    expect(refs.secrets).toEqual(["TOKEN"]);
  });

  test("returns null for a file that isn't YAML", () => {
    expect(workflowRefs("jobs: [unclosed")).toBeNull();
  });
});

describe("keypin run in a workflow", () => {
  test("finds each keypin run, the keys it names, and the job's environment", () => {
    const refs = workflowRefs(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npx keypin@0.33.1 run --env prod --only API_TOKEN,Other -- npm test
  deploy:
    environment: production
    steps:
      - name: deploy
        run: |
          keypin run \\
            --only=DEPLOY_KEY --only "SECOND" -- ./deploy.sh
      - run: keypin run -- ./all.sh
      - run: keypin run --only "\${{ inputs.key }}" -- ./one.sh
      - run: keypin run --env "\${{ inputs.env }}" -- ./any.sh
      - run: echo keypin status
`);
    assert(refs);
    expect(refs.runs).toEqual([
      { environment: null, env: "prod", dynamicEnv: false, only: ["API_TOKEN", "Other"] },
      { environment: "production", env: null, dynamicEnv: false, only: ["DEPLOY_KEY", "SECOND"] },
      { environment: "production", env: null, dynamicEnv: false, only: null },
      { environment: "production", env: null, dynamicEnv: false, only: null },
      { environment: "production", env: null, dynamicEnv: true, only: null },
    ]);
    expect(refs.uses).toEqual([]);
  });

  test("reads --env and --only the way the shell passes them, quotes removed", () => {
    const refs = workflowRefs(`
jobs:
  deploy:
    steps:
      - run: keypin run --env="prod" --only API_KEY -- ./deploy.sh
      - run: keypin run --env 'prod' --only="API_KEY" -- ./deploy.sh
      - run: keypin run "--env=prod" --only='API'_KEY -- ./deploy.sh
      - run: keypin run --env="$KEYPIN_ENV" -- ./deploy.sh
`);
    assert(refs);
    expect(refs.runs).toEqual([
      { environment: null, env: "prod", dynamicEnv: false, only: ["API_KEY"] },
      { environment: null, env: "prod", dynamicEnv: false, only: ["API_KEY"] },
      { environment: null, env: "prod", dynamicEnv: false, only: ["API_KEY"] },
      { environment: null, env: null, dynamicEnv: true, only: null },
    ]);
  });

  test("keeps a quoted --only list with spaces as one word", () => {
    const refs = workflowRefs(`
jobs:
  deploy:
    steps:
      - run: keypin run --only="FIRST, SECOND" --env="prod" -- ./deploy.sh
`);
    assert(refs);
    expect(refs.runs).toEqual([
      { environment: null, env: "prod", dynamicEnv: false, only: ["FIRST", "SECOND"] },
    ]);
  });

  test("can't tell a job's secrets apart when its environment is an expression", () => {
    const refs = workflowRefs(`
jobs:
  deploy:
    strategy:
      matrix:
        target: [staging, production]
    environment:
      name: \${{ matrix.target }}
    steps:
      - run: echo \${{ secrets.EXAMPLE_TOKEN }}
`);
    assert(refs);
    expect(refs.hidesUses).toBe(true);
  });
});
