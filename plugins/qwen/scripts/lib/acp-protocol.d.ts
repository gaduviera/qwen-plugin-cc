export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
}
export interface NewSessionResult {
  sessionId: string;
}

export interface LoadSessionParams {
  sessionId: string;
  cwd: string;
}

export interface ContentBlock {
  type: "text";
  text: string;
}
export interface PromptParams {
  sessionId: string;
  turns: Array<{ role: "user"; parts: ContentBlock[] }>;
}
export interface PromptResult {
  sessionId: string;
  stopReason: "end_turn" | "cancelled" | "error" | string;
}

export interface CancelParams {
  sessionId: string;
}

export interface SetModeParams {
  sessionId: string;
  modeId: "default" | "plan" | "auto_edit" | "yolo";
}

export interface CloseSessionParams {
  sessionId: string;
}

export interface ListSessionsResult {
  sessions: Array<{ sessionId: string; cwd: string; createdAt: string }>;
}

export type UpdateType =
  | "agent_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "current_mode_update"
  | "usage_update";

export interface SessionUpdateParams {
  sessionId: string;
  type: UpdateType;
  data: unknown;
}

export interface RequestPermissionParams {
  sessionId: string;
  permissionId: string;
  description: string;
}
export interface RequestPermissionResult {
  approved: boolean;
}

export interface ReadTextFileParams {
  path: string;
}
export interface ReadTextFileResult {
  content: string;
}

export interface WriteTextFileParams {
  path: string;
  content: string;
}

export interface TerminalCreateParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface TerminalCreateResult {
  terminalId: string;
}
