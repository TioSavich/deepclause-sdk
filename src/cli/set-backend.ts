/**
 * `deepclause set-backend pi|env|status`
 *
 * Switches the SDK between its own provider/API-key backend (`env`) and pi's
 * configured model registry (`pi`). The pi backend never asks for API keys,
 * never writes provider environment variables, and never guesses a provider.
 */

import type { Command } from 'commander';
import { loadConfig, updateConfig } from './config.js';
import { createPiBackend } from '../repl/backend.js';

export type BackendKind = 'env' | 'pi';

export interface SetBackendOptions {
  agentDir?: string;
  models?: string;
  auth?: string;
  model?: string;
}

export interface SetBackendResult {
  kind: BackendKind;
  model?: string;
  info: string;
}

export async function setBackend(
  workspaceRoot: string,
  kind: BackendKind,
  options: SetBackendOptions = {},
): Promise<SetBackendResult> {
  if (kind === 'env') {
    await updateConfig(workspaceRoot, { backend: { kind: 'env' } });
    return { kind, info: 'backend: env (SDK provider and API-key settings)' };
  }

  // Validate that pi is installed and has auth for the selected model before
  // persisting the choice.
  const probe = await createPiBackend({
    agentDir: options.agentDir,
    modelsPath: options.models,
    authPath: options.auth,
    model: options.model,
  });

  await updateConfig(workspaceRoot, {
    backend: {
      kind: 'pi',
      agentDir: options.agentDir,
      modelsPath: options.models ?? null,
      authPath: options.auth ?? null,
      model: probe.modelId,
    },
  });

  return {
    kind,
    model: probe.modelId,
    info: `backend: pi (model: ${probe.modelId})`,
  };
}

export async function getBackendStatus(workspaceRoot: string): Promise<string> {
  const config = await loadConfig(workspaceRoot);
  const backend = config.backend ?? { kind: 'env' };
  if (backend.kind === 'pi') {
    return [
      'backend: pi',
      `model: ${backend.model ?? '(first available)'}`,
      `agentDir: ${backend.agentDir ?? '(pi default)'}`,
    ].join('\n');
  }
  return [`backend: env`, `model: ${config.models.run}`].join('\n');
}

export function registerSetBackendCommand(program: Command): void {
  program
    .command('set-backend <kind>')
    .description("Select the model backend: env (SDK keys) or pi (pi's model and credentials)")
    .option('--agent-dir <path>', 'explicit pi agent dir (default: ~/.pi/agent)')
    .option('--models <path>', 'explicit models.json path')
    .option('--auth <path>', 'explicit auth.json path')
    .option('--model <provider/model>', 'pin the default model')
    .action(async (kind: string, options) => {
      try {
        if (kind === 'status') {
          console.log(await getBackendStatus(process.cwd()));
          return;
        }
        if (kind !== 'pi' && kind !== 'env') {
          console.error("❌ Unknown backend. Use 'pi', 'env', or 'status'.");
          process.exit(1);
        }
        const result = await setBackend(process.cwd(), kind, options);
        console.log(result.info);
      } catch (error) {
        console.error('❌ Error:', (error as Error).message);
        process.exit(1);
      }
    });
}
