// ACP usage -> the engine's AgentUsage. The runner reads usage from two ACP channels
// (both UNSTABLE/experimental in @agentclientprotocol/sdk@1.0.0): the per-turn
// PromptResponse.usage object and the streamed usage_update session notification. We
// tolerate either, both, or NEITHER firing — `total === 0` is the "provider reported
// nothing" sentinel the engine reads (it then falls back to a chars/4 estimate).
//
// Field mapping (frozen contract, agent-run.ts AgentUsage doc):
//   input      <- inputTokens          output     <- outputTokens
//   cacheRead  <- cachedReadTokens ?? 0 cacheWrite <- cachedWriteTokens ?? 0
//   total      <- totalTokens ?? 0      cost       <- Claude: usage_update.cost.amount (USD);
//                                                     Codex: 0 (no dollar cost reported)
//
// PromptResponse.usage is AUTHORITATIVE (it carries the input/output/cache breakdown).
// When it never fires but a backend reports tokens ONLY via usage_update (which carries
// `used` = tokens currently in context, and `size` = context window), we feed `used` into
// `total` so the engine sees a non-zero token count instead of falling back to its
// chars/4 estimate. The authoritative breakdown still wins whenever it is present.
import type { AgentUsage } from "@automatalabs/shared-types";
import type { Cost, Usage } from "@agentclientprotocol/sdk";

export interface UsageBaseline {
  costAmount: number;
  contextUsedTokens: number;
}

export class UsageAccumulator {
  private promptUsage: Usage | undefined;
  private costAmount = 0;
  private contextUsedTokens = 0;
  private contextSizeTokens = 0;

  /** Record the authoritative per-turn token usage from a PromptResponse. */
  recordPromptUsage(usage: Usage | null | undefined): void {
    if (usage) this.promptUsage = usage;
  }

  /** Record the latest cumulative dollar cost carried by a usage_update notification. */
  recordCost(cost: Cost | null | undefined): void {
    if (cost && typeof cost.amount === "number" && Number.isFinite(cost.amount)) {
      this.costAmount = cost.amount;
    }
  }

  /**
   * Record the token counts carried by a usage_update notification: `used` (tokens
   * currently in context) and `size` (context window). These feed `total` as a fallback
   * for backends that report tokens via usage_update but never via PromptResponse.usage,
   * so AgentUsage.total is non-zero whenever the backend reported ANY token count.
   */
  recordContextTokens(used: number | null | undefined, size?: number | null | undefined): void {
    if (typeof used === "number" && Number.isFinite(used) && used >= 0) this.contextUsedTokens = used;
    if (typeof size === "number" && Number.isFinite(size) && size >= 0) this.contextSizeTokens = size;
  }

  /** Snapshot the cumulative/gauge channels before a continuation turn begins. */
  baseline(): UsageBaseline {
    return {
      costAmount: this.costAmount,
      contextUsedTokens: this.contextUsedTokens,
    };
  }

  /** Report only usage observed after a reopened session's replay/setup boundary. */
  delta(baseline: UsageBaseline): AgentUsage {
    const cost = Math.max(0, this.costAmount - baseline.costAmount);
    const u = this.promptUsage;
    if (u) {
      return {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cachedReadTokens ?? 0,
        cacheWrite: u.cachedWriteTokens ?? 0,
        total: u.totalTokens ?? 0,
        cost,
      };
    }
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: Math.max(0, this.contextUsedTokens - baseline.contextUsedTokens),
      cost,
    };
  }

  toAgentUsage(): AgentUsage {
    const u = this.promptUsage;
    if (u) {
      return {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cachedReadTokens ?? 0,
        cacheWrite: u.cachedWriteTokens ?? 0,
        total: u.totalTokens ?? 0,
        cost: this.costAmount,
      };
    }
    // No authoritative per-turn breakdown: fall back to the usage_update context tokens so
    // `total` reflects what the backend reported (0 only when NEITHER channel fired).
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: this.contextUsedTokens,
      cost: this.costAmount,
    };
  }
}
