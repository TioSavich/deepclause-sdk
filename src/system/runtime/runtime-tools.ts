import * as fs from 'fs/promises';
import * as path from 'path';
import { newsSearch, webSearch } from '../../cli/search.js';
import { validateWithProlog } from '../../validate.js';
import type { Config } from '../../cli/config.js';
import type { DMLEvent, ToolDefinition } from '../../types.js';
import type { ShellManager } from './shell-manager.js';
import { createShellToolEventBridge } from './shell-tool-events.js';

const BUILT_IN_RUNTIME_TOOLS = new Set([
  'vm_exec',
  'bash',
  'write_file',
  'validate_dml',
  'web_search',
  'news_search',
  'url_fetch',
]);

const INTERNAL_TOOLS = new Set(['ask_user', 'finish', 'set_result', 'store']);
const DEFAULT_URL_FETCH_MAX_TEXT_CHARS = 20_000;

export function getBuiltInRuntimeToolNames(): string[] {
  return [...BUILT_IN_RUNTIME_TOOLS].sort();
}

export function verifyRuntimeToolsAvailable(
  config: Config,
  toolNames: string[],
): { available: boolean; missing: string[] } {
  const missing = toolNames.filter((name) => {
    if (INTERNAL_TOOLS.has(name)) {
      return false;
    }
    return !BUILT_IN_RUNTIME_TOOLS.has(name);
  });

  if (missing.length === 0) {
    return { available: true, missing: [] };
  }

  if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
    return { available: true, missing: [] };
  }

  return { available: false, missing };
}

export interface LocalRuntimeToolsOptions {
  /** Shell used by `bash`/`vm_exec` (owned by the caller). */
  shell: ShellManager;
  workspaceRoot?: string;
  workspacePath: string;
  /** Which built-in runtime tools to register; defaults to all. */
  toolNames?: string[] | null;
  signal?: AbortSignal;
  toolAbortSignalRef?: { signal?: AbortSignal };
  onEvent?: (event: DMLEvent) => void;
}

/**
 * The shared runtime-tool registry. `bash`/`vm_exec` run through the injected
 * shell; the rest are plain host tools. `deepclause run` and the REPL toolset
 * both build their tool map here, so they expose the same catalog.
 */
export function createLocalRuntimeTools(
  options: LocalRuntimeToolsOptions,
): Map<string, ToolDefinition> {
  const requested = options.toolNames ?? [...BUILT_IN_RUNTIME_TOOLS];
  const enabled = new Set(requested);
  const tools = new Map<string, ToolDefinition>();

  const getExecSignal = (): AbortSignal | undefined => {
    const toolSignal = options.toolAbortSignalRef?.signal;
    if (toolSignal && options.signal) {
      return AbortSignal.any([options.signal, toolSignal]);
    }
    return toolSignal ?? options.signal;
  };

  if (enabled.has('web_search')) {
    tools.set('web_search', {
      description: 'Search the web for information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          count: { type: 'number', description: 'Maximum result count.' },
          freshness: { type: 'string', description: 'Optional freshness filter.' },
        },
        required: ['query'],
      },
      execute: async (args) => webSearch({
        query: String(args.query ?? args.arg1 ?? ''),
        count: typeof args.count === 'number' ? args.count : 10,
        freshness: typeof args.freshness === 'string' ? args.freshness : undefined,
        signal: getExecSignal(),
      }),
    });
  }

  if (enabled.has('news_search')) {
    tools.set('news_search', {
      description: 'Search recent news.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          count: { type: 'number', description: 'Maximum result count.' },
          freshness: { type: 'string', description: 'Optional freshness filter.' },
        },
        required: ['query'],
      },
      execute: async (args) => newsSearch({
        query: String(args.query ?? args.arg1 ?? ''),
        count: typeof args.count === 'number' ? args.count : 10,
        freshness: typeof args.freshness === 'string' ? args.freshness : undefined,
        signal: getExecSignal(),
      }),
    });
  }

  if (enabled.has('url_fetch')) {
    tools.set('url_fetch', {
      description: 'Fetch a URL or save it into the workspace.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL to fetch.' },
          headers: { type: 'object', description: 'Optional request headers.' },
          save_to: { type: 'string', description: 'Optional workspace-relative output file.' },
        },
        required: ['url'],
      },
      execute: async (args) => urlFetch(options.workspacePath, args, getExecSignal()),
    });
  }

  if (enabled.has('bash')) {
    tools.set('bash', {
      description: 'Run a shell command in the active workspace shell.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
        },
        required: ['command'],
      },
      execute: async (args) => {
        const command = String(args.command ?? args.arg1 ?? '');
        return options.shell.exec(
          command,
          getExecSignal(),
          createShellToolEventBridge({ toolName: 'bash', toolArgs: { command }, emit: options.onEvent }),
        );
      },
    });
  }

  if (enabled.has('write_file')) {
    tools.set('write_file', {
      description: 'Write or overwrite a file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
      execute: async (args) => writeWorkspaceFile(options.workspacePath, args),
    });
  }

  if (enabled.has('validate_dml')) {
    tools.set('validate_dml', {
      description: 'Validate DML code from a file path inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          dml_file: { type: 'string', description: 'Workspace-relative path to the DML file.' },
        },
        required: ['dml_file'],
      },
      execute: async (args) => validateWorkspaceDml(options.workspacePath, args),
    });
  }

  if (enabled.has('vm_exec')) {
    tools.set('vm_exec', {
      description: 'Execute a shell command using the active workspace shell backend.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
        },
        required: ['command'],
      },
      execute: async (args) => {
        const command = String(args.command ?? args.arg1 ?? '');
        return options.shell.exec(
          command,
          getExecSignal(),
          createShellToolEventBridge({ toolName: 'vm_exec', toolArgs: { command }, emit: options.onEvent }),
        );
      },
    });
  }

  return tools;
}

export async function urlFetch(
  workspacePath: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = String(args.url ?? '');
  if (!url) {
    throw new Error('url is required');
  }

  const headers = isStringRecord(args.headers) ? args.headers : undefined;
  const response = await fetch(url, { headers, signal });
  const responseHeaders = Object.fromEntries(response.headers.entries());

  if (typeof args.save_to === 'string' && args.save_to.trim()) {
    const targetPath = resolveWorkspacePath(workspacePath, args.save_to);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, buffer);
    return {
      file_path: targetPath,
      size: buffer.byteLength,
      status: response.status,
      headers: responseHeaders,
    };
  }

  const body = await response.text();
  const truncated = truncateUrlFetchTextBody(body);

  return {
    body: truncated.body,
    truncated: truncated.truncated,
    original_length: truncated.originalLength,
    returned_length: truncated.returnedLength,
    status: response.status,
    headers: responseHeaders,
  };
}

export function truncateUrlFetchTextBody(body: string, maxChars = DEFAULT_URL_FETCH_MAX_TEXT_CHARS): {
  body: string;
  truncated: boolean;
  originalLength: number;
  returnedLength: number;
} {
  const originalLength = body.length;
  if (originalLength <= maxChars) {
    return {
      body,
      truncated: false,
      originalLength,
      returnedLength: originalLength,
    };
  }

  const notice = `\n... (truncated from ${originalLength} chars to ${maxChars} chars; use save_to to keep the full response)`;
  const clipped = body.slice(0, maxChars) + notice;
  return {
    body: clipped,
    truncated: true,
    originalLength,
    returnedLength: clipped.length,
  };
}

export function resolveWorkspacePath(workspacePath: string, filePath: string): string {
  if (!filePath) {
    throw new Error('Path is required');
  }

  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path must stay inside workspace: ${filePath}`);
  }
  return resolved;
}

async function writeWorkspaceFile(
  workspacePath: string,
  args: Record<string, unknown>,
): Promise<{ success: boolean; path?: string; bytes?: number; error?: string }> {
  const relPath = String(args.path ?? '');
  const content = String(args.content ?? '');
  if (!relPath) {
    return { success: false, error: 'path is required' };
  }

  const filePath = resolveWorkspacePath(workspacePath, relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return { success: true, path: relPath, bytes: content.length };
}

async function validateWorkspaceDml(
  workspacePath: string,
  args: Record<string, unknown>,
): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
  const dmlPath = resolveWorkspacePath(workspacePath, String(args.dml_file ?? ''));
  const dml = await fs.readFile(dmlPath, 'utf8');
  const result = await validateWithProlog(dml);
  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings ?? [],
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}
