# docs/archive — why these files are here

This folder holds earlier versions of design documents that have been superseded.
They are **not** deleted because:

1. **Git history isn't enough** — the submission is judged by reviewers who clone
   the repo and look at the current state, not the diff. Leaving superseded designs
   here lets a reviewer understand the path we took without digging through commits.
2. **Circle Product Feedback evidence** — `CIRCLE_FEEDBACK.md` cites specific pain
   points hit during development. The archived documents are the paper trail that
   makes those claims concrete and credible (targeting the hackathon's $500 Product
   Feedback Incentive).
3. **Honesty** — nothing in our public materials claims we got this right on the
   first pass. Keeping the evolution visible is consistent with the "no mocks, no
   fallbacks, no hardcoding" standard applied to the code.

## Contents

| File | Superseded by | Why |
|---|---|---|
| `DESIGN.original.md` | `/DESIGN.md` (v2) and `/IMPLEMENTATION_REVISION.md` | §3 architecture used a single-SSE-stream-with-402-pauses pattern that is not implementable against `@x402/express`. Rewritten as one HTTP request per chunk. |
| `STRUCTURE.original.md` | `/STRUCTURE.md` (v2) | Moved from buyer-as-Node-process to buyer-as-library. Added `web-server/`. |

## Reading order

If you're a reviewer or future contributor trying to understand why things are
structured the way they are, read in this order:

1. `/PROJECT_CONTEXT.md` — the authoritative project context (unchanged)
2. `/IMPLEMENTATION_REVISION.md` — what changed from the original design and why
3. `/DESIGN.md` — the current architecture
4. `/STRUCTURE.md` — the current file layout
5. `/UI_SPEC.md` — the UI panels (mostly unchanged — only data-source notes tweaked)

The archived files here are reference; do not build against them.
