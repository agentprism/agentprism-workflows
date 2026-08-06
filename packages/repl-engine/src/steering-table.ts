/**
 * The per-backend steering MECHANISM table — the roadmap doc's spec-owed
 * decision ("the table is documentation generated from the capability
 * probes"), implemented as a GENERATED artifact: this module derives the
 * table from the live capability probes in `@automatalabs/acp-agents`'s
 * `ACP_EXTENSION_SUPPORT_MATRIX` (`packages/acp-agents/src/protocol-
 * coverage.ts` — probed by the protocol-coverage suite against the
 * installed Claude/Codex distributions; pi is workspace-owned and tested
 * in its own suite; opencode's `typed-unsupported` disposition means the
 * public wrapper exists and rejects from initialize negotiation before
 * emitting a wire request).
 *
 * The mechanism per backend follows directly from the disposition:
 *
 * - `supported` → the backend advertises `_session/steering` → LIVE
 *   INJECTION via `session.steer()` while a turn is in flight (a fresh
 *   `session.prompt` when the session is idle — there is nothing to
 *   inject into);
 * - anything else (`typed-unsupported`, `not-advertised`) → the backend
 *   does NOT advertise the extension → QUEUED-FOR-NEXT-TURN DELIVERY
 *   (the honest `queued` outcome; the payload is delivered durably on
 *   the session's next turn boundary, see the broker's module docs);
 * - a CUSTOM backend is capability-gated per session at open time
 *   (`session.capabilities.supportsSteering` — whatever the agent's
 *   initialize response advertises): live injection when advertised,
 *   queued delivery otherwise.
 *
 * The generated markdown is checked in at `docs/steering-mechanism-
 * table.md` and GATED by `test/steering-table.test.ts`: the gate
 * regenerates the document in memory and compares it byte-for-byte with
 * the checked-in file, so a capability-matrix change that is not
 * reflected in the documentation fails the suite (the doc's "the table
 * is documentation generated from the capability probes" is enforced,
 * never deferred). Regenerate with
 * `pnpm --filter @automatalabs/repl-engine generate:steering-table`.
 */

import { ACP_EXTENSION_SUPPORT_MATRIX, SESSION_STEERING_METHOD } from '@automatalabs/acp-agents';

/** One generated table row: the backend's advertised `_session/steering`
 *  disposition and the mechanism that follows from it. */
export interface SteeringMechanismRow {
  backend: string;
  /** Whether the backend advertises `_session/steering` (the probe
   *  matrix's disposition, rendered for the table). */
  advertised: boolean;
  /** The steering mechanism the broker uses for this backend. */
  mechanism: 'live injection' | 'queued delivery';
  /** The probe evidence (the matrix row's disposition token). */
  disposition: 'supported' | 'typed-unsupported' | 'not-advertised';
  /** The installed-distribution probe backing the row, when the matrix
   *  carries one (`claude` / `codex`); none for pi (workspace-owned) and
   *  opencode. */
  distProbe?: 'claude' | 'codex';
}

/** Derive the per-backend steering mechanism table from the capability
 *  probes (see the module docs). The built-in backends come from
 *  `ACP_EXTENSION_SUPPORT_MATRIX` (the `_session/steering` rows, in the
 *  matrix's order); the custom-backend row is the capability-gated
 *  fallback every session negotiates at open. */
export function steeringMechanismRows(): SteeringMechanismRow[] {
  const rows: SteeringMechanismRow[] = [];
  for (const row of ACP_EXTENSION_SUPPORT_MATRIX) {
    if (row.method !== SESSION_STEERING_METHOD) continue;
    const advertised = row.disposition === 'supported';
    rows.push({
      backend: row.agent,
      advertised,
      mechanism: advertised ? 'live injection' : 'queued delivery',
      disposition: row.disposition,
      distProbe: row.distProbe,
    });
  }
  return rows;
}

/** The mechanism table's fixed prose sections (the outcome surface and
 *  the per-case mechanism rows are the broker's documented behavior,
 *  sourced from the same capability decision; the generator emits them
 *  so the document stays one artifact). */
const MECHANISM_CASES = `The per-session capability is read ONCE at session open (\`session.capabilities.supportsSteering\`);
the mechanism table for one session:

| Case | Mechanism | Outcome the handle resolves with |
|---|---|---|
| backend advertises \`_session/steering\`, turn in flight | \`session.steer(content)\` — live injection | the backend's verbatim outcome: \`injected\` \\| \`startedNewTurn\` \\| \`failed\` |
| backend advertises \`_session/steering\`, session idle | \`session.prompt(content)\` — a new turn (there is nothing to inject into) | \`startedNewTurn\` |
| backend does NOT advertise steering, turn in flight | content enqueued for next-turn delivery | \`queued\` (immediately — accepted for next-turn delivery; if the call is later cancelled the queue is dropped, and a delivery-turn failure surfaces as a warn-level line in the next tool result) |
| backend does NOT advertise steering, session idle | \`session.prompt(content)\` — a new turn | \`startedNewTurn\` |
| ANY backend, session idle, but the workspace cap is exhausted | content enqueued for the next free slot (the same durable queue) | \`queued\` (a follow-up turn IS the subagent working — the six-agent ceiling is absolute; the steer starts the moment a slot frees) |
| any backend/wire failure on the steering path | — | \`failed\` (never a hard rejection) |
| the founding call is still OPENING (its session does not exist yet — a steer in the same eval as the dispatch) | content queued for the call's next-turn boundary | \`queued\` |
| no live session for the founding call at all (never opened, or lost) | — | \`failed\` (nothing was steered) |
| \`cancel()\` with a turn in flight | ACP \`session/cancel\` | \`cancelled\` (the cancelled call itself rejects with the recoverable \`CancelledError\`) |
| \`cancel()\` with the session idle | no-op — the agent is already stopped | \`idle\` |
| \`cancel()\` while the call is still opening | no-op — nothing was running to cancel (the call continues) | \`failed\` |

The outcome surface therefore mirrors acp-agents' \`SteeringOutcome\` values (\`injected\` /
\`startedNewTurn\` / \`failed\`) with one honest addition (\`queued\`) for the no-extension
enqueue case, plus the cancel vocabulary (\`cancelled\` / \`idle\`) — the orchestrator can always
tell urgency delivery (injected) from next-turn delivery (queued / startedNewTurn), which is the
doc's stated requirement.`;

/** Generate the full per-backend steering mechanism table as markdown
 *  (the doc's generated documentation). Deterministic: the same matrix
 *  always produces the same document, so the gate test can compare it
 *  byte-for-byte with the checked-in artifact. */
export function generateSteeringMechanismTable(): string {
  const rows = steeringMechanismRows();
  const lines: string[] = [];
  lines.push('# Per-backend steering mechanism table');
  lines.push('');
  lines.push('<!-- GENERATED — do not edit by hand. Sourced from the live capability probes in');
  lines.push('`@automatalabs/acp-agents`\'s `ACP_EXTENSION_SUPPORT_MATRIX`');
  lines.push('(`packages/acp-agents/src/protocol-coverage.ts`; claude/codex probed against the installed');
  lines.push('distributions by the protocol-coverage suite, pi workspace-owned and covered in its own');
  lines.push('suite, opencode `typed-unsupported`). Regenerate:');
  lines.push('`pnpm --filter @automatalabs/repl-engine generate:steering-table`. The gate test');
  lines.push('(`test/steering-table.test.ts`) fails when this file drifts from the probes. -->');
  lines.push('');
  lines.push('The per-backend inventory — which backends advertise `_session/steering` today versus');
  lines.push('fall back to queued-for-next-turn delivery (the roadmap doc\'s spec-owed table, generated');
  lines.push('from the capability probes; the mechanism per disposition is the broker\'s decision, see');
  lines.push('`src/broker.ts`\'s module docs):');
  lines.push('');
  lines.push('| Backend | `_session/steering` | Steering mechanism |');
  lines.push('|---|---|---|');
  for (const row of rows) {
    const probe = row.distProbe !== undefined ? ` (probed: ${row.distProbe})` : '';
    lines.push(
      `| ${row.backend} | ${row.advertised ? 'advertised' : 'NOT advertised'}${probe} | ${row.mechanism} via \`session.${row.advertised ? 'steer()' : 'prompt()/queue'}\` |`,
    );
  }
  lines.push('| custom backend | whatever the agent\'s initialize response advertises (capability-gated per session at open) | live injection when advertised, queued delivery otherwise |');
  lines.push('');
  lines.push(MECHANISM_CASES);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
