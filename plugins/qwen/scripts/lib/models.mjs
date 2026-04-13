// plugins/qwen/scripts/lib/models.mjs
// Model selection is handled by the Qwen CLI based on the user's account.
// We pass through whatever the user specifies, or null to use the CLI default.

export function resolveModel(input) {
  if (input == null || input === '') return null;
  return String(input).trim() || null;
}

export function listKnownModels() {
  return [];
}
