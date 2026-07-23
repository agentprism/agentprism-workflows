export function fmtDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtClock(ts: number): string {
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtCost(cost: number): string {
  return cost >= 100 ? `$${Math.round(cost)}` : `$${cost.toFixed(2)}`;
}

/** Mockup-style short run handle: the trailing 4 characters of the run id. */
export function shortRunId(runId: string): string {
  return runId.slice(-4);
}
