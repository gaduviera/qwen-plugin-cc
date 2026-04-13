---
description: Check whether the local Qwen CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" setup --json $ARGUMENTS
```

After the readiness check above:
- If the parsed result has `auth.loggedIn: false`, use `AskUserQuestion` exactly once to ask whether the user wants:
  - `Login with OAuth (free) (Recommended)`
  - `Use API key (DASHSCOPE_API_KEY)`
- If the user chooses `Login with OAuth (free) (Recommended)`, guide them to run `!qwen auth login`.
- If the user chooses `Use API key (DASHSCOPE_API_KEY)`, guide them to set the `DASHSCOPE_API_KEY` environment variable.
- Preserve any auth guidance already present in the setup output.

If the result says Qwen is unavailable:
- Tell the user to install the Qwen CLI: `npm install -g @qwen-code/qwen-code`. Refer them to https://github.com/QwenLM/qwen-code
- Do not attempt to install it yourself.

If Qwen is installed but not authenticated:
- Tell the user to either run `!qwen auth login` for OAuth or set the `DASHSCOPE_API_KEY` environment variable.
- Preserve any guidance in the setup output.

Output rules:
- Present the final setup output to the user.
