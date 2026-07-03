import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type {
  AgentResult,
  AgentRunner,
  JournalEntry,
  PromptImage,
  RunOptions,
} from "@automatalabs/shared-types";
import { runWorkflow } from "../src/workflow.js";

// agent({ images }) is an ADDITIVE run input: the engine must thread it through to the runner
// opts verbatim (the ACP runner turns it into image ContentBlocks), but it must NOT enter the
// resume identity hash (hashAgentCall) — it shapes the agent, not the logical call, exactly like
// mcpServers/meta.

describe("agent({ images }) plumbing", () => {
  it("threads images from agent() into the runner opts", async () => {
    let images: readonly PromptImage[] | undefined;
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: RunOptions<S>,
      ): Promise<AgentResult<S>> {
        images = options?.images;
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'm', description: 'images' }
const a = await agent('p', {
  label: 'a',
  images: [{ data: 'ZmFrZQ==', mimeType: 'image/png', uri: 'file:///tmp/a.png' }],
})
return a`;

    await runWorkflow(script, { agent: capturing, persistLogs: false });

    // Cross-realm objects have a different Object.prototype; normalize through JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(images)), [
      { data: "ZmFrZQ==", mimeType: "image/png", uri: "file:///tmp/a.png" },
    ]);
  });

  it("passes undefined through when images are not provided", async () => {
    let sawOptions = false;
    let images: unknown = "sentinel";
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: RunOptions<S>,
      ): Promise<AgentResult<S>> {
        sawOptions = true;
        images = options?.images;
        return "ok" as AgentResult<S>;
      },
    };
    await runWorkflow(
      `export const meta = { name: 'm', description: 'images' }
return await agent('p', { label: 'a' })`,
      { agent: capturing, persistLogs: false },
    );
    assert.ok(sawOptions);
    assert.equal(images, undefined);
  });

  it("does NOT fold images into the resume identity hash", async () => {
    const echo: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
        return `ran:${prompt}` as AgentResult<S>;
      },
    };
    const journalOf = async (withImages: boolean): Promise<JournalEntry[]> => {
      const journal: JournalEntry[] = [];
      const opts = withImages
        ? `{ label: 'a', images: [{ data: 'ZmFrZQ==', mimeType: 'image/png', uri: 'file:///tmp/a.png' }] }`
        : `{ label: 'a' }`;
      const script = `export const meta = { name: 'm2', description: 'images' }
return await agent('same', ${opts})`;
      await runWorkflow(script, {
        agent: echo,
        persistLogs: false,
        onAgentJournal: (e) => journal.push(e),
      });
      return journal;
    };

    const withImages = await journalOf(true);
    const withoutImages = await journalOf(false);
    assert.deepEqual(
      withImages,
      withoutImages,
      "adding images must keep the journal byte-identical (not part of the identity)",
    );
  });
});
