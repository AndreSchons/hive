export {
  createAdapterRegistry,
  type AdapterCapabilities,
  type AdapterProbe,
  type AdapterRegistry,
  type AgentAdapter,
  type AgentOutcome,
  type AgentRun,
  type AgentRunRequest,
} from './adapter';
export { git, gitOrThrow, lines, type GitResult } from './git/git';
export { GitWorktreeManager, branchFor, BRANCH_PREFIX, type RepositoryCheck } from './git/git-worktree';
export { ClaudeAdapter, type ClaudeAdapterOptions } from './claude/claude-adapter';
export { ClaudeRun, type ClaudeRunOptions } from './claude/claude-run';
export { parseCliLine, type CliLine } from './claude/cli-messages';
export {
  decidePermission,
  isInside,
  type PermissionDecision,
  type PermissionRequest,
  type ToolKind,
} from './permission';
export { fileChangeFrom, type FileChange } from './claude/patch';
export { describeToolCall, describeToolResult, type ToolDescription } from './tool-summary';
export { StreamTranslator, maxCostUsd, type TranslateContext } from './claude/translate';
export { KimiAdapter, type KimiAdapterOptions } from './kimi/kimi-adapter';
export { KimiRun, type KimiRunOptions } from './kimi/kimi-run';
export { AcpClient, type AcpHandlers } from './kimi/acp-client';
export { AcpTranslator, type KimiTranslateContext } from './kimi/acp-translate';
export {
  parseFrame,
  sessionUpdateSchema,
  requestPermissionParamsSchema,
  type SessionUpdate,
  type StopReason,
} from './kimi/acp-messages';
export { MockAdapter, type MockAdapterOptions } from './mock/mock-adapter';
export { AsyncQueue } from './process/async-queue';
export { LineSplitter, parseLine, readStreamJson, type StreamLine } from './process/stream-json';
export type {
  CreateWorktreeInput,
  MergeResult,
  Worktree,
  WorktreeDiff,
  WorktreeManager,
} from './worktree';
