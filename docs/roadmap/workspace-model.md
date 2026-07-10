# Workspace model

**Status:** designed · **Updated:** 2026-07-10

A workspace is **any folder** the user points the system at — not a format we impose. The
model's one law: *never pollute what you were pointed at.* It becomes load-bearing for
[remote execution](remote-execution.md), where the runner materializes workspaces.

## Core decisions

- **Owned vs. guest modes.** A workspace the user created through us is *owned* (we may keep
  metadata in it). Any pre-existing folder — someone's real repo — is a *guest* workspace: we
  write nothing into it beyond what a run legitimately produces.
- **Snapshots via namespaced refs.** Run-level snapshots of a git workspace are recorded under
  a namespaced ref area (never branches/tags the user sees, never commits on their branches).
  Existing repos stay byte-for-byte theirs; snapshot state is removable by deleting the
  namespace.
- **Workflows are associated, not checked in.** A workflow relates to a workspace in our
  metadata. Writing the workflow file into the repo (`.agentprism/` or similar) is an explicit
  opt-in **materialize** action — useful for teams who want workflows reviewed in-repo, never
  a side effect.
- **Prompts resolve through three scopes:** workspace > team > personal, nearest scope wins.

## Consequences

- Agents always run against a concrete folder (locally the user's own; remotely a
  runner-materialized checkout), so `cwd` semantics stay identical across execution modes.
- Guest-mode discipline is what makes "point it at your existing repo" a safe first-run
  experience — nothing to clean up, nothing to explain to teammates.
