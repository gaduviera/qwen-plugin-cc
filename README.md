# Qwen Plugin for Claude Code

Use Qwen CLI from inside Claude Code for code reviews or to delegate tasks to Qwen.

This plugin adapts the Qwen CLI for seamless integration with Claude Code, letting you leverage Qwen's code analysis and task execution capabilities directly from your Claude Code workflow.

<img width="1774" height="887" alt="image" src="https://github.com/user-attachments/assets/2295eb6a-8ec2-41ce-a46d-787afa33e735" />


## What You Get

- `/qwen:review` for a normal read-only Qwen code review
- `/qwen:adversarial-review` for a steerable challenge review
- `/qwen:rescue`, `/qwen:status`, `/qwen:result`, and `/qwen:cancel` to delegate work and manage background jobs
- `/qwen:task` to submit custom tasks to Qwen
- `/qwen:setup` to initialize and verify your Qwen environment

## Requirements

- **Qwen CLI** installed and available in your PATH
  - [Install from Qwen repository](https://github.com/QwenLM/qwen-code)
- **Authentication**: Either OAuth login or `DASHSCOPE_API_KEY` environment variable
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add gaduviera/qwen-plugin-cc
```

Install the plugin:

```bash
/plugin install qwen@gaduviera-qwen
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/qwen:setup
```

`/qwen:setup` will verify that Qwen is installed and authenticated.

If Qwen is installed but not authenticated, you can log in with:

```bash
!qwen auth login
```

Or set your API key directly:

```bash
export DASHSCOPE_API_KEY=your-api-key-here
```

After install, you should see the slash commands listed below.

One simple first run is:

```bash
/qwen:review --background
/qwen:status
/qwen:result
```

## Usage

### `/qwen:review`

Runs a normal Qwen review on your current work. It gives you the same quality of code review as running `/review` inside Qwen directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/qwen:adversarial-review`](#qwenadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/qwen:review
/qwen:review --base main
/qwen:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/qwen:status`](#qwenstatus) to check on the progress and [`/qwen:cancel`](#qwencancel) to cancel the ongoing task.

### `/qwen:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/qwen:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/qwen:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/qwen:adversarial-review
/qwen:adversarial-review --base main challenge whether this was the right caching and retry design
/qwen:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/qwen:rescue`

Hands a task to Qwen through the `qwen:qwen-rescue` subagent.

Use it when you want Qwen to:

- investigate a bug
- try a fix
- continue a previous Qwen task
- take a pass on a specific problem or code area

> [!NOTE]
> Depending on the task, these tasks might take a long time and it's generally recommended to force the task to be in the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/qwen:rescue investigate why the tests started failing
/qwen:rescue fix the failing test with the smallest safe patch
/qwen:rescue --resume apply the top fix from the last run
/qwen:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Qwen:

```text
Ask Qwen to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass flags, Qwen chooses its own defaults
- follow-up rescue requests can continue the latest Qwen task in the repo

### `/qwen:task`

Submit a custom task to Qwen for execution.

Use it when you want to:

- run a specific code analysis
- perform a targeted fix or refactoring
- investigate a particular problem

Examples:

```bash
/qwen:task optimize the database query performance
/qwen:task add comprehensive error handling to the API module
```

### `/qwen:status`

Shows running and recent Qwen jobs for the current repository.

Examples:

```bash
/qwen:status
/qwen:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/qwen:result`

Shows the final stored Qwen output for a finished job.
When available, it includes the Qwen session ID so you can reference that run directly.

Examples:

```bash
/qwen:result
/qwen:result task-abc123
```

### `/qwen:cancel`

Cancels an active background Qwen job.

Examples:

```bash
/qwen:cancel
/qwen:cancel task-abc123
```

### `/qwen:setup`

Checks whether Qwen is installed and authenticated. If Qwen is missing, it can offer guidance on installation.

You can also use `/qwen:setup` to verify your current environment and authentication state.

## Typical Flows

### Review Before Shipping

```bash
/qwen:review
```

### Hand A Problem To Qwen

```bash
/qwen:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/qwen:adversarial-review --background
/qwen:rescue --background investigate the flaky test
```

Then check in with:

```bash
/qwen:status
/qwen:result
```

## Authentication

### OAuth Login

If you have a Qwen account with OAuth support:

```bash
qwen auth login
```

This will open a browser window to authenticate. Follow the prompts to authorize access.

### API Key Authentication

If you prefer to use an API key, set the `DASHSCOPE_API_KEY` environment variable:

```bash
export DASHSCOPE_API_KEY=your-dashscope-api-key
```

You can verify your authentication state at any time with:

```bash
/qwen:setup
```

## Integration with Qwen CLI

The Qwen plugin uses the ACP (Agent Communication Protocol) to communicate with your local Qwen CLI. It uses the global `qwen` binary installed in your environment and applies the same configuration.

### Qwen CLI Documentation

For more information about Qwen CLI, configuration options, and advanced usage:

- [Qwen Code Repository](https://github.com/QwenLM/qwen-code)
- [Qwen CLI Documentation](https://github.com/QwenLM/qwen-code#documentation)

## FAQ

### Do I need a separate Qwen account for this plugin?

If you are already signed into Qwen on this machine, that account should work immediately here too. This plugin uses your local Qwen CLI authentication.

If you only use Claude Code today and have not used Qwen yet, you will need to sign in to Qwen with either an OAuth account or an API key. Run `/qwen:setup` to check whether Qwen is ready, and use `!qwen auth login` or set `DASHSCOPE_API_KEY` if it is not.

### Does the plugin use a separate Qwen runtime?

No. This plugin delegates through your local Qwen CLI using the ACP protocol.

That means:

- it uses the same Qwen install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### How do I authenticate with Qwen?

You have two options:

1. **OAuth Login**: Run `qwen auth login` to authenticate with your Qwen account
2. **API Key**: Set the `DASHSCOPE_API_KEY` environment variable with your DashScope API key

### Can I use environment-specific configurations with Qwen?

Yes. Your Qwen configuration (if you have one) will be respected by this plugin. Qwen will use the same settings you would use when running it directly.

### What if Qwen CLI is not installed?

Run `/qwen:setup` to check your environment. It will tell you if Qwen is missing and provide guidance on installation. 

To install Qwen CLI, visit the [Qwen repository](https://github.com/QwenLM/qwen-code) and follow the installation instructions.
