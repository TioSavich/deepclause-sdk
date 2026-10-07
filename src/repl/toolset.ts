/**
 * REPL capability host tools.
 *
 * The only capability tool is **`bash`**, registered through the SDK's shell
 * manager and sandbox config. Everything else the model needs (file I/O,
 * search, fetching) is DML language, a linked script run through `bash`, or the
 * human-in-the-loop channel (`ask_user` / `input/2`). `--tools`/`--no-tools`
 * control whether `bash` is registered.
 */

import { createShellManager, type HostShellConfig } from '../system/runtime/shell-manager.js';
import { createShellToolEventBridge } from '../system/runtime/shell-tool-events.js';
import type { DMLEvent, ToolDefinition } from '../types.js';

export const DEFAULT_REPL_TOOLS = ['bash'] as const;

export interface ReplToolsetOptions {
  workspacePath: string;
  sandbox?: boolean;
  network?: boolean;
  hostConfig?: HostShellConfig;
  /** Capability tool names to register. `null`/empty means no capability tools. */
  toolNames?: string[] | null;
  signal?: AbortSignal;
  onEvent?: (event: DMLEvent) => void;
}

export interface ReplToolset {
  tools: Map<string, ToolDefinition>;
  /** Catalog text injected into the meta prompt. */
  catalog: string;
  dispose(): Promise<void>;
}

/** Human-readable catalog of the registered capability tools. */
export function buildToolCatalog(tools: Map<string, ToolDefinition>): string {
  if (tools.size === 0) {
    return 'No capability host tools are registered. Use DML/Prolog, or write a script file and run it with exec(bash(...)).';
  }
  const lines: string[] = [];
  for (const [name, tool] of tools) {
    const properties = tool.parameters?.properties ?? {};
    const params = Object.keys(properties).join(', ') || 'none';
    lines.push(`- ${name}: ${tool.description} (parameters: ${params})`);
  }
  lines.push('');
  lines.push('DML file I/O always uses the MI predicates (open/3, close/1, read_string/3, write/2, write_file/2, read_file/2, append_file/2); it is not a host tool.');
  return lines.join('\n');
}

export async function createReplToolset(options: ReplToolsetOptions): Promise<ReplToolset> {
  const requested = options.toolNames === null
    ? []
    : options.toolNames ?? [...DEFAULT_REPL_TOOLS];
  const tools = new Map<string, ToolDefinition>();
  let shell = requested.includes('bash')
    ? createShellManager({
      workspacePath: options.workspacePath,
      sandbox: options.sandbox,
      network: options.network,
      hostConfig: options.hostConfig,
    })
    : null;

  if (shell) {
    const shellManager = shell;
    tools.set('bash', {
      description: 'Run a shell command in the active workspace shell.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
        },
        required: ['command'],
      },
      execute: async (args, context) => {
        const command = String(args.command ?? args.arg1 ?? '');
        // Prefer the per-turn signal the runner/agent loop passes so Ctrl-C
        // terminates the running command (fall back to a startup signal).
        return shellManager.exec(
          command,
          context?.signal ?? options.signal,
          createShellToolEventBridge({
            toolName: 'bash',
            toolArgs: { command },
            emit: options.onEvent,
          }),
        );
      },
    });
  }

  return {
    tools,
    catalog: buildToolCatalog(tools),
    dispose: async () => {
      if (shell) {
        await shell.dispose();
        shell = null;
      }
    },
  };
}
