import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/qwen/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "no-issues",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "no-issues",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Qwen returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderReviewResult renders a clean review with verdict and summary", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "no-issues",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      },
      rawOutput: JSON.stringify({
        verdict: "no-issues",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      }),
      parseError: null
    },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /# Qwen Review/);
  assert.match(output, /Verdict: no-issues/);
  assert.match(output, /No material findings\./);
});

test("renderReviewResult renders findings sorted by severity", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "Issues found.",
        findings: [
          {
            severity: "low",
            title: "Low finding",
            body: "Minor.",
            file: "a.js",
            recommendation: ""
          },
          {
            severity: "high",
            title: "High finding",
            body: "Critical.",
            file: "b.js",
            recommendation: "Fix it."
          }
        ],
        next_steps: ["Run tests."]
      },
      rawOutput: "{}",
      parseError: null
    },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /\[high\] High finding/);
  assert.match(output, /\[low\] Low finding/);
  // high finding should appear before low finding
  const highIdx = output.indexOf("[high]");
  const lowIdx = output.indexOf("[low]");
  assert.ok(highIdx < lowIdx, "high finding should appear before low finding");
  assert.match(output, /Next steps:/);
  assert.match(output, /Run tests\./);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Qwen Adversarial Review",
      jobClass: "review",
      threadId: "sess_123"
    },
    {
      threadId: "sess_123",
      rendered: "# Qwen Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Qwen Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Qwen session ID: sess_123/);
  assert.match(output, /Resume in Qwen: qwen resume sess_123/);
});

test("renderStoredJobResult falls back to job metadata when no rendered output is available", () => {
  const output = renderStoredJobResult(
    {
      id: "task-abc",
      status: "failed",
      title: "Qwen Task",
      jobClass: "task",
      errorMessage: "Something went wrong."
    },
    null
  );

  assert.match(output, /# Qwen Task/);
  assert.match(output, /Job: task-abc/);
  assert.match(output, /Status: failed/);
  assert.match(output, /Something went wrong\./);
});
