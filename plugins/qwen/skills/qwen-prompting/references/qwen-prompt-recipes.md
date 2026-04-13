# Qwen Prompt Recipes

## Recipe: Code Review with Explicit Scope Constraint

Always place context (git diff) BEFORE the query. State DO NOT constraints explicitly.

```
[git diff context here]

Review the diff above for security issues only.

DO NOT suggest refactors, style changes, or improvements outside the security scope.
DO NOT modify code.

Respond with ONLY valid JSON (no markdown fences):
{"verdict":"...","summary":"...","findings":[...],"next_steps":[...]}
```

## Recipe: Long-Context Task (Query Last)

Put the task at the very end when providing large context (>50K tokens):

```
[Full codebase context, docs, examples...]

Based on ALL the context above, implement X in file Y.
```

## Recipe: Controlling Thinking Budget

For complex reasoning — enable with a cap:
```
<budget_tokens>8000</budget_tokens>
Analyze the tradeoffs between approach A and approach B.
```

For simple tasks — disable thinking:
```
<budget_tokens>0</budget_tokens>
List all TODO comments in this file.
```

## Recipe: Forcing Raw JSON Output

Qwen tends to wrap JSON in markdown fences. Force raw output:
```
Respond with ONLY valid JSON. No prose. No markdown fences. No explanation.
```
