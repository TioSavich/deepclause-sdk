/**
 * `deepclause set-backend pi|env|status`
 *
 * Switches the SDK between its own provider/API-key backend (`env`) and pi's
 * configured model registry (`pi`). The pi backend never asks for API keys on
 * its own, never writes provider environment variables, and never guesses a
 * provider — it reuses pi's model catalog and credential store.
 *
 * `set-backend pi` is also the setup flow: it discovers (or installs) the pi
 * package, lists pi's model catalog, lets the user pick a model, and runs pi's
 * own login flow when the provider is not yet authenticated. Neither the pi CLI
 * nor a pre-existing pi session is required.
 */

import type { Command } from 'commander';
import { spawn } from 'child_process';
import * as readline from 'readline';

import { loadConfig, updateConfig } from './config.js';
import {
  createPiBackend,
  isPiPackageAvailable,
  openPiRuntime,
  type PiAuthInteractionLike,
  type PiModelInfo,
  type PiProviderInfo,
  type PiRuntimeHandle,
} from '../repl/backend.js';

export type BackendKind = 'env' | 'pi';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

export interface SetBackendOptions {
  agentDir?: string;
  models?: string;
  auth?: string;
  model?: string;
  provider?: string;
  apiKey?: string;
  install?: boolean;
  list?: boolean;
  json?: boolean;
  login?: boolean;
}

export interface SetBackendResult {
  kind: BackendKind;
  model?: string;
  provider?: string;
  info: string;
  /** Present when `--list` was used. */
  providers?: PiProviderInfo[];
  models?: PiModelInfo[];
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Terminal implementation of pi's login interaction callbacks. */
export function terminalAuthInteraction(): PiAuthInteractionLike {
  return {
    async prompt(prompt) {
      if (prompt.options && prompt.options.length > 0) {
        const lines = prompt.options.map((option, index) => {
          const description = option.description ? ` — ${option.description}` : '';
          return `  ${index + 1}. ${option.label}${description}`;
        });
        const answer = await ask(`${prompt.message}\n${lines.join('\n')}\n> `);
        const byIndex = Number(answer.trim()) - 1;
        if (Number.isInteger(byIndex) && prompt.options[byIndex]) {
          return prompt.options[byIndex].id;
        }
        const byId = prompt.options.find((option) => option.id === answer.trim());
        return byId ? byId.id : answer.trim();
      }
      const placeholder = prompt.placeholder ? ` (${prompt.placeholder})` : '';
      return ask(`${prompt.message}${placeholder}\n> `);
    },
    notify(event) {
      if (event.type === 'auth_url' && event.url) {
        console.log(`\nOpen this URL to authorize:\n  ${event.url}`);
        if (event.instructions) console.log(event.instructions);
      } else if (event.type === 'device_code') {
        console.log(`\nVisit ${event.verificationUri} and enter code: ${event.userCode}`);
      } else if (event.message) {
        console.log(event.message);
      }
      for (const link of event.links ?? []) {
        console.log(`  ${link.label ?? link.url}: ${link.url}`);
      }
    },
  };
}

function apiKeyInteraction(apiKey: string): PiAuthInteractionLike {
  return {
    prompt: async () => apiKey,
    notify: (event) => {
      if (event.message) console.log(event.message);
    },
  };
}

async function installPiPackage(): Promise<void> {
  console.log(`Installing ${PI_PACKAGE} (this provides pi's model catalog and credential store)…`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['install', `${PI_PACKAGE}@^1.0.0`], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install exited with code ${code}`));
      }
    });
  });
}

async function requirePiPackage(options: SetBackendOptions): Promise<void> {
  if (isPiPackageAvailable()) return;
  if (options.install) {
    await installPiPackage();
    if (isPiPackageAvailable()) return;
  }
  throw new Error(
    `pi backend needs the ${PI_PACKAGE} package. Install it with `
    + `\`npm install ${PI_PACKAGE}\` (or re-run with --install), `
    + 'or run `deepclause set-backend env` to use the SDK provider/API-key backend.',
  );
}

/** Pick a model from pi's catalog (explicit, filtered, or interactive). */
export async function choosePiModel(
  handle: PiRuntimeHandle,
  options: SetBackendOptions,
): Promise<PiModelInfo> {
  const toInfo = (model: { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }): PiModelInfo => ({
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    reasoning: Boolean(model.reasoning),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  });

  if (options.model) {
    const requested = options.model.replace(':', '/');
    const [provider, ...rest] = requested.split('/');
    const modelId = rest.join('/');
    const found = modelId ? handle.registry.find?.(provider, modelId) : undefined;
    if (found) {
      return toInfo(found as { provider: string; id: string; name?: string; reasoning?: boolean });
    }
    const models = handle.listModels(options.provider);
    const match = models.find((model) => `${model.provider}/${model.id}` === requested || model.id === options.model);
    if (match) return match;
    throw new Error(`pi model not found: ${options.model}`);
  }

  const models = handle.listModels(options.provider);
  if (models.length === 0) {
    throw new Error(`no pi models found${options.provider ? ` for provider '${options.provider}'` : ''}`);
  }
  if (models.length === 1) {
    return models[0];
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `multiple pi models are available (${models.length}); pass --model <provider/model> or --provider <id>`,
    );
  }

  console.log(`\nAvailable pi models (${models.length}):\n`);
  models.forEach((model, index) => {
    const label = model.name && model.name !== model.id ? ` — ${model.name}` : '';
    const reasoning = model.reasoning ? ' [reasoning]' : '';
    console.log(`  ${index + 1}. ${model.provider}/${model.id}${label}${reasoning}`);
  });
  const answer = await ask(`\nChoose a model (1-${models.length}): `);
  const index = Number(answer.trim()) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= models.length) {
    throw new Error('invalid model selection');
  }
  return models[index];
}

/** Ensure pi has credentials for the chosen provider (using pi's login flow). */
export async function ensurePiAuth(
  handle: PiRuntimeHandle,
  provider: string,
  options: SetBackendOptions,
): Promise<void> {
  if (handle.hasAuth(provider)) return;

  if (options.apiKey) {
    await handle.login(provider, apiKeyInteraction(options.apiKey), 'api_key');
    return;
  }

  const info = handle.listProviders().find((candidate) => candidate.id === provider);
  const canOAuth = Boolean(info?.oauth);
  const canApiKey = info?.apiKey !== false;

  if (options.login === false || !process.stdin.isTTY) {
    throw new Error(
      `pi has no credentials for provider '${provider}'. `
      + `Run 'pi auth' to sign in, or pass --api-key <key>.`,
    );
  }

  let type: 'api_key' | 'oauth' = canOAuth && !canApiKey ? 'oauth' : 'api_key';
  if (canOAuth && canApiKey) {
    const answer = await ask(
      `\nAuthenticate '${provider}' with:\n  1. API key\n  2. OAuth / subscription\n> `,
    );
    type = answer.trim() === '2' ? 'oauth' : 'api_key';
  }

  console.log(`\nStarting pi login for '${provider}' (${type})…`);
  await handle.login(provider, terminalAuthInteraction(), type);
}

async function setupPiBackend(
  workspaceRoot: string,
  options: SetBackendOptions,
): Promise<SetBackendResult> {
  await requirePiPackage(options);

  const handle = await openPiRuntime({
    agentDir: options.agentDir,
    modelsPath: options.models,
    authPath: options.auth,
    model: options.model,
  });

  if (options.list) {
    const providers = handle.listProviders();
    const models = handle.listModels(options.provider);
    return {
      kind: 'pi',
      info: `pi catalog: ${providers.length} providers, ${models.length} models`,
      providers,
      models,
    };
  }

  const model = await choosePiModel(handle, options);
  await ensurePiAuth(handle, model.provider, options);

  // Validate that the model is usable before persisting the choice.
  const probe = await createPiBackend({
    modelRegistry: handle.registry,
    model: `${model.provider}/${model.id}`,
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
    kind: 'pi',
    model: probe.modelId,
    provider: model.provider,
    info: `backend: pi (model: ${probe.modelId})`,
  };
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
  return setupPiBackend(workspaceRoot, options);
}

export async function getBackendStatus(workspaceRoot: string): Promise<string> {
  const config = await loadConfig(workspaceRoot);
  const backend = config.backend ?? { kind: 'env' };
  if (backend.kind === 'pi') {
    return [
      'backend: pi',
      `model: ${backend.model ?? '(first available)'}`,
      `agentDir: ${backend.agentDir ?? '(pi default)'}`,
      `pi package: ${isPiPackageAvailable() ? 'available' : 'NOT FOUND'}`,
    ].join('\n');
  }
  return ['backend: env', `model: ${config.models.run}`].join('\n');
}

export function registerSetBackendCommand(program: Command): void {
  program
    .command('set-backend <kind>')
    .description("Select the model backend: env (SDK keys), pi (pi's catalog/credentials), or status")
    .option('--agent-dir <path>', 'explicit pi agent dir (default: ~/.pi/agent)')
    .option('--models <path>', 'explicit models.json path')
    .option('--auth <path>', 'explicit auth.json path')
    .option('--model <provider/model>', 'pin the default model (skips the picker)')
    .option('--provider <id>', 'restrict the catalog/picker to one provider')
    .option('--api-key <key>', 'store an API key for the provider in pi credentials')
    .option('--install', `install ${PI_PACKAGE} if it is missing`)
    .option('--list', 'list pi providers and models without changing the backend')
    .option('--json', 'machine-readable output (with --list or status)')
    .option('--no-login', 'do not start an interactive login; fail if unauthenticated')
    .action(async (kind: string, options) => {
      try {
        if (kind === 'status') {
          const config = await loadConfig(process.cwd());
          if (options.json) {
            console.log(JSON.stringify({
              kind: config.backend?.kind ?? 'env',
              model: config.backend?.model,
              agentDir: config.backend?.agentDir,
              piAvailable: isPiPackageAvailable(),
            }));
          } else {
            console.log(await getBackendStatus(process.cwd()));
          }
          return;
        }
        if (kind !== 'pi' && kind !== 'env') {
          console.error("❌ Unknown backend. Use 'pi', 'env', or 'status'.");
          process.exit(1);
        }

        const result = await setBackend(process.cwd(), kind, options);
        if (options.list) {
          if (options.json) {
            console.log(JSON.stringify({ providers: result.providers, models: result.models }, null, 2));
          } else {
            console.log(`\npi providers (${result.providers?.length ?? 0}):\n`);
            for (const provider of result.providers ?? []) {
              console.log(`  ${provider.id} (${provider.name})`
                + `${provider.configured ? ' — configured' : ' — not configured'}`
                + ` [${[provider.apiKey ? 'api-key' : null, provider.oauth ? 'oauth' : null].filter(Boolean).join(', ') || 'ambient'}]`);
            }
            console.log(`\npi chat models (${result.models?.length ?? 0}):\n`);
            for (const model of result.models ?? []) {
              console.log(`  ${model.provider}/${model.id}${model.reasoning ? ' [reasoning]' : ''}`);
            }
          }
          return;
        }
        console.log(result.info);
      } catch (error) {
        console.error('❌ Error:', (error as Error).message);
        process.exit(1);
      }
    });
}
