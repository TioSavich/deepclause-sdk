/**
 * The REPL authoring agent.
 *
 * This is a normal TypeScript agent loop over the injected `LLMBackend`: a
 * system prompt plus harness tools. It replaces the old DML `task_named` meta
 * frame for authoring, so the runtime's frame machinery is only used for
 * DML-internal `task/N` calls.
 */

import { readAgentPromptAsset } from '../system/assets/index.js';
import type {
  DMLEvent,
  LLMBackend,
  LLMBackendMessage,
  LLMBackendResponse,
  LLMBackendToolCall,
  MemoryMessage,
  ToolDefinition,
} from '../types.js';
import { compactMemory, shouldCompact, type CompactionSettings } from './compaction.js';
import type { HarnessToolController } from './harness-tools.js';

export interface HarnessAgentOptions {
  controller: HarnessToolController;
  tools: Map<string, ToolDefinition>;
  llmBackend: LLMBackend;
  model: string;
  temperature?: number;
  maxTokens?: number;
  streaming?: boolean;
  /** Maximum model calls for one `run` (0 = unlimited). */
  maxModelCalls?: number;
  contextWindow?: number;
  compaction?: { settings: CompactionSettings; auto: boolean };
  /** Host capability tool catalog text, injected into the system prompt. */
  hostToolsCatalog?: string;
  /** Workspace root, so a `.deepclause/system/AGENT_PROMPT.md` override is used. */
  workspacePath?: string;
  /** Docs embedded in the system prompt (`agentDocs: 'embed'`). */
  docs?: { reference?: string; authoring?: string };
  /** Pre-loaded documentation for the `reference` tool (handled by the controller). */
  knownMessages?: MemoryMessage[];
}

export interface HarnessAgentRunOptions {
  signal?: AbortSignal;
}

const MAX_TOOL_RESULT_CHARS = 8000;

/** Generate the `TOOLS` section of the system prompt from the tool schemas. */
export function describeTools(tools: Map<string, ToolDefinition>): string {
  const lines: string[] = [];
  for (const [name, tool] of tools) {
    const properties = (tool.parameters.properties ?? {}) as Record<string, { type?: string }>;
    const required = new Set(tool.parameters.required ?? []);
    const params = Object.entries(properties)
      .map(([param, schema]) => `${param}${required.has(param) ? '' : '?'}: ${schema.type ?? 'any'}`)
      .join(', ');
    lines.push(`- ${name}(${params}): ${tool.description}`);
  }
  return lines.join('\n');
}

/** Build the authoring agent's system prompt from the bundled template. */
export async function buildAgentSystemPrompt(options: {
  tools: Map<string, ToolDefinition>;
  hostToolsCatalog?: string;
  manifest: string;
  workspacePath?: string;
  /** Embedded DML language reference (`{{REFERENCE}}`). */
  reference?: string;
  /** Embedded DML authoring guide (`{{AUTHORING}}`). */
  authoring?: string;
}): Promise<string> {
  let template = '';
  try {
    template = await readAgentPromptAsset({ workspacePath: options.workspacePath });
  } catch {
    template = 'You are the DeepClause REPL harness agent.';
  }
  return template
    .replace('{{CATALOG}}', options.hostToolsCatalog ?? '(no host capability tools registered)')
    .replace('{{TOOLS}}', describeTools(options.tools))
    .replace('{{MANIFEST}}', options.manifest || '(empty harness)')
    .replace('{{REFERENCE}}', options.reference?.trim() || '(call reference("language"))')
    .replace('{{AUTHORING}}', options.authoring?.trim() || '(call reference("authoring"))');
}

/** Project the agent's message list onto `MemoryMessage[]` for compaction. */
function toMemoryMessages(messages: LLMBackendMessage[]): MemoryMessage[] {
  const out: MemoryMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content });
    } else if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      const calls = (message.toolCalls ?? [])
        .map((call) => `${call.name}(${JSON.stringify(call.arguments)})`)
        .join(', ');
      out.push({ role: 'assistant', content: calls ? `${message.content}\n[tool calls: ${calls}]` : message.content });
    } else {
      out.push({ role: 'user', content: `[tool result: ${message.toolName ?? 'tool'}] ${message.content}` });
    }
  }
  return out;
}

function fromMemoryMessages(messages: MemoryMessage[]): LLMBackendMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function stringifyToolResult(result: unknown): string {
  let text: string;
  if (typeof result === 'string') {
    text = result;
  } else {
    try {
      text = JSON.stringify(result);
    } catch {
      text = String(result);
    }
  }
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… [truncated]`
    : text;
}

/**
 * A multi-turn authoring agent. `run` yields `DMLEvent`s (streaming text,
 * reasoning, tool calls, usage, errors) and follows the tool loop until the
 * model calls `finish` or the budget runs out.
 */
export class HarnessAgent {
  readonly tools: Map<string, ToolDefinition>;
  private readonly options: HarnessAgentOptions;
  private messages: LLMBackendMessage[];

  constructor(options: HarnessAgentOptions) {
    this.options = options;
    this.tools = options.tools;
    this.messages = options.knownMessages
      ? options.knownMessages
          // Defensively drop any older host nudge persisted as a user message.
          .filter((message) => message.content.trim() !== 'Continue: call a tool, or call finish when done.')
          .map((message) => ({ role: message.role, content: message.content }))
      : [];
  }

  /** The persisted conversation (real user/assistant turns only, no host nudges). */
  getMessages(): MemoryMessage[] {
    return this.messages
      .filter((message) => message.role === 'system' || message.role === 'user' || message.role === 'assistant')
      // Drop assistant turns that only carry tool calls (empty text).
      .filter((message) => message.role !== 'assistant' || (message.content ?? '').trim() !== '')
      .map((message) => ({ role: message.role as MemoryMessage['role'], content: message.content }));
  }

  async *run(request: string, options: HarnessAgentRunOptions = {}): AsyncGenerator<DMLEvent> {
    const { controller, llmBackend, tools } = this.options;
    const streaming = this.options.streaming ?? true;
    const maxModelCalls = this.options.maxModelCalls ?? 0;
    const settings = this.options.compaction?.settings;
    const autoCompact = this.options.compaction?.auto ?? false;

    let manifest = '';
    try {
      manifest = await controller.manifest();
    } catch {
      // best effort: the agent can still call `listing`
    }
    const systemPrompt = await buildAgentSystemPrompt({
      tools,
      hostToolsCatalog: this.options.hostToolsCatalog,
      manifest,
      workspacePath: this.options.workspacePath,
      reference: this.options.docs?.reference,
      authoring: this.options.docs?.authoring,
    });

    this.messages.push({ role: 'user', content: request });

    const backendTools = [...tools].map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    }));
    backendTools.push({
      name: 'finish',
      description: 'Finish the request. Call when the harness change is committed (or the question is answered).',
      parameters: {
        type: 'object',
        properties: { success: { type: 'boolean' } },
        required: ['success'],
      },
    });

    let calls = 0;
    let finished = false;
    let lastText = '';
    let lastInputTokens: number | undefined;
    const maxIterations = 1000;

    while (!finished && calls < maxIterations) {
      if (options.signal?.aborted) break;
      if (maxModelCalls > 0 && calls >= maxModelCalls) {
        yield { type: 'error', content: `model-call budget exhausted (${maxModelCalls})` };
        break;
      }
      calls += 1;

      if (autoCompact && settings?.enabled && this.options.contextWindow) {
        const projected = toMemoryMessages(this.messages);
        if (shouldCompact(lastInputTokens ?? 0, this.options.contextWindow, settings)) {
          const result = await compactMemory({
            messages: projected,
            backend: llmBackend,
            model: this.options.model,
            contextWindow: this.options.contextWindow,
            settings,
            signal: options.signal,
          });
          if (result.applied) {
            this.messages = fromMemoryMessages(result.messages);
            yield {
              type: 'memory_compaction',
              content: `compact session.before_model_call applied ${result.tokensBefore} -> ${result.tokensAfter} tokens`,
              compactionScope: 'session',
              compactionTrigger: 'before_model_call',
              compactionAction: 'applied',
              beforeTokens: result.tokensBefore,
              afterTokens: result.tokensAfter,
            };
          }
        }
      }

      yield { type: 'model_call', modelCallState: 'started', modelId: this.options.model };

      // Stream deltas live via a queue while the (single) backend call runs.
      const streamQueue: DMLEvent[] = [];
      let wake: (() => void) | null = null;
      let settled = false;
      let response: LLMBackendResponse | undefined;
      let failure: unknown;
      const push = (event: DMLEvent): void => {
        streamQueue.push(event);
        if (wake) {
          const resolve = wake;
          wake = null;
          resolve();
        }
      };
      const requestMessages: LLMBackendMessage[] = [
        { role: 'system', content: systemPrompt },
        ...this.messages,
      ];

      const completion = llmBackend.complete({
        messages: requestMessages,
        tools: backendTools,
        temperature: this.options.temperature,
        maxTokens: this.options.maxTokens,
        signal: options.signal,
        onText: streaming ? (chunk) => push({ type: 'stream', content: chunk }) : undefined,
        onReasoning: streaming ? (chunk) => push({ type: 'reasoning', content: chunk }) : undefined,
      }).then(
        (value) => { response = value; settled = true; if (wake) { const r = wake; wake = null; r(); } },
        (error) => { failure = error; settled = true; if (wake) { const r = wake; wake = null; r(); } },
      );

      while (true) {
        while (streamQueue.length > 0) yield streamQueue.shift()!;
        if (settled) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      while (streamQueue.length > 0) yield streamQueue.shift()!;
      await completion;

      if (failure || !response) {
        yield { type: 'model_call', modelCallState: 'failed', modelId: this.options.model };
        yield { type: 'error', content: failure instanceof Error ? failure.message : String(failure) };
        return;
      }
      yield { type: 'model_call', modelCallState: 'completed', modelId: this.options.model };

      if (response.usage) {
        lastInputTokens = (response.usage.inputTokens ?? 0)
          + (response.usage.cacheReadTokens ?? 0)
          + (response.usage.cacheWriteTokens ?? 0);
        yield { type: 'usage', usage: response.usage, usageSource: 'llm', usageModel: this.options.model };
      }
      if (response.text) {
        lastText = response.text;
      }

      const toolCalls: LLMBackendToolCall[] = response.toolCalls ?? [];
      this.messages.push({
        role: 'assistant',
        content: response.text,
        toolCalls,
        providerData: response.providerData,
      });

      if (toolCalls.length === 0) {
        // No tool call: the model answered directly or stopped; end the turn.
        break;
      }

      for (const call of toolCalls) {
        yield { type: 'tool_call', toolName: call.name, toolArgs: call.arguments, toolState: 'starting' };
        if (call.name === 'finish') {
          finished = true;
          yield { type: 'tool_call', toolName: 'finish', toolArgs: call.arguments, toolState: 'completed', toolSummary: 'done' };
          this.messages.push({ role: 'tool', content: '{"finished":true}', toolCallId: call.id, toolName: 'finish' });
          break;
        }
        const tool = tools.get(call.name);
        if (!tool) {
          const message = `Tool not found: ${call.name}`;
          yield { type: 'tool_call', toolName: call.name, toolState: 'failed', toolError: message };
          this.messages.push({ role: 'tool', content: JSON.stringify({ error: message }), toolCallId: call.id, toolName: call.name });
          continue;
        }
        let result: unknown;
        try {
          result = await tool.execute(call.arguments, { signal: options.signal });
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        const text = stringifyToolResult(result);
        yield { type: 'tool_call', toolName: call.name, toolArgs: call.arguments, toolState: 'completed', toolSummary: text.slice(0, 200) };
        this.messages.push({ role: 'tool', content: text, toolCallId: call.id, toolName: call.name });
      }
    }

    if (!finished && !options.signal?.aborted) {
      yield { type: 'log', content: 'authoring agent reached its iteration limit without finishing' };
    }
    if (!streaming && lastText) {
      yield { type: 'output', content: lastText };
    }
  }
}
