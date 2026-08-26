import { ACP_EXTENSION_SUPPORT_MATRIX, SESSION_STEERING_METHOD } from '@automatalabs/acp-agents';

/** One documentation-only distribution-probe row. Runtime routing never reads this table. */
export interface SteeringMechanismRow {
  backend: string;
  advertised: boolean;
  mechanism: 'strict active-turn injection' | 'unsupported';
  disposition: 'supported' | 'typed-unsupported' | 'not-advertised';
  distProbe?: 'claude' | 'codex';
}

/** Derive the checked-in inventory from executable distribution probes. */
export function steeringMechanismRows(): SteeringMechanismRow[] {
  const rows: SteeringMechanismRow[] = [];
  for (const row of ACP_EXTENSION_SUPPORT_MATRIX) {
    if (row.method !== SESSION_STEERING_METHOD) continue;
    const advertised = row.disposition === 'supported';
    rows.push({
      backend: row.agent,
      advertised,
      mechanism: advertised ? 'strict active-turn injection' : 'unsupported',
      disposition: row.disposition,
      distProbe: row.distProbe,
    });
  }
  return rows;
}

const MECHANISM_CASES = `Runtime steering availability is read from the session's raw initialize metadata only:
\`initializeMeta.steering.supported === true\`. The distribution matrix above is documentation,
not a runtime router.

| Case | Wire behavior | Result |
|---|---|---|
| ACP prompt in flight; raw steering advertised | one strict \`_session/steering\` request with \`idleBehavior: "promptRequired"\` | \`injected\`, or \`idle\` for \`promptRequired\` |
| ACP prompt in flight; raw steering not advertised | no request | \`unsupported\` |
| no ACP prompt in flight, including opening/extraction/repair gaps | no request | \`idle\` |
| steering transport/server failure | no prompt fallback | rejects \`AGENT_EXECUTION_ERROR\` |
| malformed response or \`startedNewTurn\` | cancel + fatal session lane | rejects non-recoverably |

Future work is always explicit: \`handle.queue(prompt)\` creates a distinct, durable FIFO public
turn and the broker sends it through ordinary \`session/prompt\` only when it reaches the queue
head. Queueing never uses \`_session/steering\` or a backend-native queue.`;

/** Generate the complete deterministic documentation artifact. */
export function generateSteeringMechanismTable(): string {
  const rows = steeringMechanismRows();
  const lines: string[] = [];
  lines.push('# Per-backend steering mechanism table');
  lines.push('');
  lines.push('<!-- GENERATED — do not edit by hand. Sourced from the executable distribution probes in');
  lines.push('`@automatalabs/acp-agents`\'s `ACP_EXTENSION_SUPPORT_MATRIX`. Regenerate:');
  lines.push('`pnpm --filter @automatalabs/repl-engine generate:steering-table`. Runtime behavior does');
  lines.push('NOT read this table; it parses each session\'s raw initialize metadata. -->');
  lines.push('');
  lines.push('The installed-distribution inventory:');
  lines.push('');
  lines.push('| Backend | `_session/steering` | Strict steering behavior |');
  lines.push('|---|---|---|');
  for (const row of rows) {
    const probe = row.distProbe !== undefined ? ` (probed: ${row.distProbe})` : '';
    const behavior = row.advertised
      ? 'strict active-turn injection via `session.steer()`'
      : 'unsupported (no steering wire request)';
    lines.push(`| ${row.backend} | ${row.advertised ? 'advertised' : 'NOT advertised'}${probe} | ${behavior} |`);
  }
  lines.push('| custom backend | whatever its raw initialize metadata advertises | strict active-turn injection when advertised; unsupported otherwise |');
  lines.push('');
  lines.push(MECHANISM_CASES);
  return `${lines.join('\n')}\n`;
}
