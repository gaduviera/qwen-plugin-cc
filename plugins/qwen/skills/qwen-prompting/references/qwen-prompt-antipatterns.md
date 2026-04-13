# Qwen Prompt Antipatterns

## "I Know Better" Syndrome
**What:** Qwen modifies code it wasn't asked to touch — refactors nearby functions, adds comments.
**Fix:** Explicit DO NOT constraints: "Modify ONLY the function named X. DO NOT change any other code."

## Vague Scope
**What:** "Review this code" → Qwen reviews everything and outputs prose instead of structured findings.
**Fix:** Specify scope: "Review ONLY the authentication flow in src/auth.js for security vulnerabilities."

## Missing DO NOT Constraints
**What:** Qwen does unwanted work when you don't state what NOT to do.
**Fix:** State constraints explicitly. Always include what should NOT be touched.

## Query Before Context
**What:** Putting the task at the top and context below. Qwen performs worse on this in long prompts.
**Fix:** Context first, query last (Google's official guidance).

## Uncapped Thinking Mode
**What:** Auto thinking mode on routine tasks can cost ~37x more tokens.
**Fix:** Use `<budget_tokens>0</budget_tokens>` for simple tasks.

## Relying on Stale Session Context
**What:** After >200K tokens, recall of early context drops significantly.
**Fix:** Use `--fresh` for new tasks. Re-provide minimal context.

## Expecting Structured Output Without Specifying It
**What:** Qwen wraps JSON in markdown by default.
**Fix:** Always say: "Respond with ONLY valid JSON. No markdown fences."
