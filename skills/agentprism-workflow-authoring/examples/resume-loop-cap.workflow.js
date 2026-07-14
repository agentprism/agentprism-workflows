// resume-loop-cap — demonstrate raising an orchestration-only cap on resume.
// Run once with maxRounds=6 to journal six expensive rounds and halt; run again
// with maxRounds=8 plus the first runId as resumeFromRunId. The first six prompts
// are unchanged, so they replay for zero tokens and only rounds 7–8 run live.
export const meta = {
  name: "resume-loop-cap",
  description: "Run expensive review rounds up to an args-controlled cap",
  phases: [{ title: "Review" }],
};

const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
const numericCap = Number(input.maxRounds);
const maxRounds = Number.isInteger(numericCap) && numericCap > 0 ? numericCap : 8;

phase("Review");
const rounds = [];
for (let i = 0; i < maxRounds; i += 1) {
  rounds.push(
    await agent(
      `Review round ${i + 1}: inspect the repository and report unresolved release blockers.`,
      { label: `review:${i + 1}`, phase: "Review" },
    ),
  );
}

if (maxRounds < 8) throw new Error(`review cap ${maxRounds} reached before 8 rounds`);
return { rounds };
