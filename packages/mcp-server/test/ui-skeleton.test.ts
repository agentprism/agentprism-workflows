// The run-monitor skeleton extractor must key call sites exactly the way the engine's
// captureCallPath keys runtime calls: same meta-splice, same body-relative "line:column"
// convention. The gold test runs real scripts through the engine with a stub runner and
// asserts every captured innermost path component resolves in the extractor's byKey.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow } from "@automatalabs/workflows";
import type { AgentResult, AgentRunner, RunOptions } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";

import { extractSkeleton, innermostKey, spliceMetaForBody } from "../ui/src/skeleton.js";

async function enginePathsFor(script: string, concurrency?: number): Promise<string[]> {
  const paths: string[] = [];
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(
      _prompt: string,
      options?: RunOptions<S>,
    ): Promise<AgentResult<S>> {
      if (options?.callPath !== undefined) paths.push(options.callPath);
      return "ok" as AgentResult<S>;
    },
  };
  await runWorkflow(script, {
    agent: runner,
    persistLogs: false,
    ...(concurrency === undefined ? {} : { concurrency }),
  });
  return paths;
}

const META = `export const meta = {
  name: 'skeleton-fixture',
  description: 'skeleton extractor fixture',
  phases: [{ title: 'Research' }, { title: 'Verify' }],
}`;

const SCRIPT = `${META}
phase('Research')
const notes = await parallel(['a', 'b', 'c'].map((t) => () => agent(\`Research \${t}\`, { label: \`research:\${t}\` })))
function helper(p) { return agent(p, { label: 'helped' }) }
await helper('via helper')
let dry = 0
while (dry < 2) {
  await agent('probe the state', { label: 'prober' })
  dry += 1
}
phase('Verify')
const verdicts = await parallel([
  () => agent('lens one'),
  () => agent('lens two'),
])
return { notes, verdicts }`;

test("every engine call path resolves to an extractor site by innermost key", async () => {
  const skeleton = extractSkeleton(SCRIPT);
  assert.notEqual(skeleton, undefined);
  const paths = await enginePathsFor(SCRIPT);
  // 3 mapped + 1 helper + 2 loop iterations + 2 literal thunks.
  assert.equal(paths.length, 8);
  for (const path of paths) {
    const site = skeleton?.byKey.get(innermostKey(path));
    assert.notEqual(site, undefined, `no skeleton site for engine path ${path}`);
    assert.equal(site?.kind, "agent");
  }
  // The loop's two iterations and the fan-out's three members collapse to single sites.
  assert.equal(new Set(paths.map(innermostKey)).size, 5);
  assert.equal(skeleton?.byKey.size, 5);
});

test("skeleton structure: phases, groups, loop containers, previews, static counts", () => {
  const skeleton = extractSkeleton(SCRIPT);
  assert.notEqual(skeleton, undefined);
  const kinds = skeleton?.roots.map((node) => node.kind);
  // phase, parallel group, helper site (lexical position), helper-call statement contributes
  // nothing (aliased call site), loop, phase, parallel group.
  assert.deepEqual(kinds, ["phase", "group", "site", "loop", "phase", "group"]);

  const [research, fanout, helperSite, loop, verify, literalGroup] = skeleton?.roots ?? [];
  assert.deepEqual(research, { kind: "phase", title: "Research" });
  assert.deepEqual(verify, { kind: "phase", title: "Verify" });

  assert.equal(fanout?.kind, "group");
  if (fanout?.kind === "group") {
    assert.equal(fanout.mode, "parallel");
    assert.equal(fanout.staticCount, 3);
    assert.equal(fanout.children.length, 1);
    const child = fanout.children[0];
    assert.equal(child?.kind, "site");
    if (child?.kind === "site") {
      assert.equal(child.site.promptPreview, "Research …");
      assert.equal(child.site.labelPreview, "research:…");
    }
  }

  assert.equal(helperSite?.kind, "site");
  if (helperSite?.kind === "site") assert.equal(helperSite.site.labelPreview, "helped");

  assert.equal(loop?.kind, "loop");
  if (loop?.kind === "loop") {
    assert.equal(loop.children.length, 1);
    const probe = loop.children[0];
    assert.equal(probe?.kind, "site");
    if (probe?.kind === "site") assert.equal(probe.site.promptPreview, "probe the state");
  }

  assert.equal(literalGroup?.kind, "group");
  if (literalGroup?.kind === "group") {
    assert.equal(literalGroup.staticCount, 2);
    assert.equal(literalGroup.children.length, 2);
  }
});

test("pipeline stages partition children per stage argument", () => {
  const script = `${META}
const results = await pipeline(
  items,
  (item) => agent(\`review \${item}\`),
  (review) => agent(\`verify \${review}\`),
)
return results`;
  const skeleton = extractSkeleton(script);
  const group = skeleton?.roots[0];
  assert.equal(group?.kind, "group");
  if (group?.kind === "group") {
    assert.equal(group.mode, "pipeline");
    assert.equal(group.staticCount, undefined);
    assert.equal(group.stages?.length, 2);
    assert.equal(group.children.length, 2);
    const [first, second] = group.stages ?? [];
    assert.equal(first?.[0]?.kind, "site");
    assert.equal(second?.[0]?.kind, "site");
  }
});

test("stdlib helper agents resolve to the helper call site; retry/loopUntilDry stay script-mapped", async () => {
  const script = `${META}
const audit = await verify('claim to refute', { reviewers: 2 })
const flaky = await retry(() => agent('attempt the flaky thing', { label: 'flaky' }), { attempts: 2, until: () => true })
const swept = await loopUntilDry({
  round: async () => { await agent('sweep for findings', { label: 'sweeper' }); return [] },
  consecutiveEmpty: 1,
})
return { audit, flaky, swept }`;

  const skeleton = extractSkeleton(script);
  assert.notEqual(skeleton, undefined);
  const sites = [...(skeleton?.byKey.values() ?? [])];
  const verifySite = sites.find((site) => site.kind === "stdlib" && site.helper === "verify");
  assert.notEqual(verifySite, undefined);
  assert.equal(verifySite?.promptPreview, "claim to refute");
  // retry is transparent (its thunk is script code); loopUntilDry becomes a loop container.
  assert.equal(sites.filter((site) => site.kind === "agent").length, 2);
  assert.equal(skeleton?.roots.some((node) => node.kind === "loop"), true);

  const paths = await enginePathsFor(script);
  // 2 verify reviewers + 1 retry attempt + 1 loopUntilDry round.
  assert.equal(paths.length, 4);
  for (const path of paths) {
    assert.notEqual(
      skeleton?.byKey.get(innermostKey(path)),
      undefined,
      `no skeleton site for engine path ${path}`,
    );
  }
  const verifyPaths = paths.filter((path) => innermostKey(path) === verifySite?.key);
  assert.equal(verifyPaths.length, 2);
});

test("limiter saturation never costs a path: capture happens at agent() entry, pre-limiter", async () => {
  // concurrency: 1 forces every fan-out member after the first through the limiter queue.
  // Thunks are invoked eagerly and the path is captured before admission, so queued agents
  // keep the same site key — including engine-side stdlib fan-outs, whose only script frame
  // is the helper's call site.
  const script = `${META}
const audit = await verify('claim under load', { reviewers: 3 })
return audit`;
  const skeleton = extractSkeleton(script);
  const verifyKey = [...(skeleton?.byKey.values() ?? [])].find((site) => site.helper === "verify")?.key;
  const paths = await enginePathsFor(script, 1);
  assert.equal(paths.length, 3);
  assert.deepEqual([...new Set(paths.map(innermostKey))], [verifyKey]);
});

test("splice matches the engine convention and unparseable scripts fall back", () => {
  // The spliced body keeps the newline after the meta statement, so line 1 is blank and the
  // first statement lands on line 2 — the same coordinates captureCallPath normalizes to.
  const body = spliceMetaForBody(`export const meta = { name: 'x', description: 'y' }\nawait agent('a')`);
  assert.equal(body, "\nawait agent('a')");
  assert.equal(extractSkeleton("not a workflow script ("), undefined);
  assert.equal(extractSkeleton("const x = 1"), undefined);
});
