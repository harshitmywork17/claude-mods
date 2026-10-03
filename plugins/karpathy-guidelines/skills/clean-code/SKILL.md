---
name: clean-code
description: Behavioral guidelines to reduce common LLM coding mistakes — overcomplication, unrequested refactors, drive-by style changes, vague success criteria. Use this whenever writing, reviewing, editing, refactoring, or debugging ANY code, no matter how small the task seems — a one-line fix, a "quick" feature, a bug report, a "clean this up" request, or a full new module. Always consult this skill before producing code, and read EXAMPLES.md (bundled alongside this file) for concrete before/after cases of each principle. Trigger even if the user doesn't mention "guidelines," "best practices," or "code quality" explicitly — any coding task qualifies.
license: MIT
---

# Clean Code

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

**Companion file:** `EXAMPLES.md`, bundled in this same skill folder, contains full worked examples (❌ wrong vs. ✅ right, real code, real diffs) for every principle below. Read it whenever you want a concrete pattern to check your work against — not just for ambiguous cases, but as a default step before finishing a coding task. Don't paraphrase it from memory; open and read the file itself so nothing is missed.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

See `EXAMPLES.md` § 1 for the "hidden assumptions" (data export) and "multiple interpretations" (search speed) cases.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

See `EXAMPLES.md` § 2 for the "over-abstraction" (discount strategy pattern) and "speculative features" (preference manager) cases.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

See `EXAMPLES.md` § 3 for the "drive-by refactoring" (email validator bug fix) and "style drift" (logging addition) cases.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

See `EXAMPLES.md` § 4 for the "vague vs. verifiable" (auth fix), "multi-step with verification" (rate limiting), and "test-first verification" (sorting bug) cases.

## Quick self-check before finishing any coding task

- [ ] Did I state assumptions instead of guessing silently? (Principle 1)
- [ ] Is this the simplest version that solves what was actually asked? (Principle 2)
- [ ] Does every changed line trace back to the request — no drive-by cleanup, no style drift? (Principle 3)
- [ ] Do I have a verifiable success criterion (a test, a repro case, a before/after check)? (Principle 4)

If any box is unchecked, go back and fix it before presenting the result — don't just note it as a caveat.
