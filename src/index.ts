/**
 * DeepClause SDK - Simplified DML Language Runtime
 * 
 * A neurosymbolic AI system combining Prolog-based symbolic reasoning
 * with LLM-powered task execution.
 */

export { createDeepClause } from './sdk.js';
export type { 
  CompactionAction,
  CompactionOptions,
  CompactionScope,
  CompactionTrigger,
  CompactorBinding,
  CompactorDefinition,
  CompactorSourceType,
  CreateOptions,
  DeepClauseSDK,
  LLMBackend,
  LLMBackendMessage,
  LLMBackendRequest,
  LLMBackendResponse,
  LLMBackendTool,
  LLMBackendToolCall,
  LLMUsage,
  MemoryMessage,
  RunOptions,
  CompileOptions,
  CompileResult,
  CompileTool,
  DMLEvent,
  TraceEntry,
  ToolDefinition,
  ToolPolicy 
} from './types.js';

// DML REPL (goal + prompt mode) for CLI and embedding
export { createHarnessRepl } from './repl/index.js';
export { DMLSession } from './repl/session.js';
export type { HarnessRepl, HarnessReplOptions, RunOpts, DMLQueryEvent, ReplEvent } from './repl/index.js';
export type { DMLSessionOptions, DMLQueryOptions } from './repl/session.js';
export type { HarnessExportOptions, HarnessExportResult } from './repl/export.js';
export { createPiBackend, createPiAdapter, resolvePiPaths, selectPiModel } from './repl/backend.js';
export { createReplToolset, buildToolCatalog } from './repl/toolset.js';
export { HistoryStore } from './repl/history.js';
export type {
  HistoryOptions,
  HistoryTrace,
  HistoryTurnRecord,
  HistoryChangeRecord,
  HistoryChangedPredicate,
  HistoryEventContext,
} from './repl/history.js';

// Compiler utilities — also available via the 'deepclause-sdk/compiler' subpath
export {
  compileToDML,
  extractParameters,
  extractToolDependencies,
  extractDescription,
  validateWithProlog,
  analyzeDML,
} from './compiler.js';

// Judgment layer: generic judge primitives with pluggable backends
export {
  createMockJudgeBackend,
  createMockJevJudgeBackend,
  createJevJudgeBackend,
  createLLMJudgeBackend,
  buildJudgePrompt,
  parseJudgeResponse,
} from './judge/index.js';
export type {
  JudgeAnswer,
  JudgeBackend,
  JudgeBackendRequest,
  JudgeBackendResponse,
  JudgeBasis,
  JudgeCapabilities,
  JudgeLevel,
  JudgeOption,
  JudgeQuestion,
  JudgeQuestionKind,
  JudgeSelection,
  JudgeUsage,
  JsonValue,
  JevJudgeBackendOptions,
  LLMJudgeBackendOptions,
  MockAnswerSource,
  MockJudgeBackendOptions,
} from './judge/index.js';
