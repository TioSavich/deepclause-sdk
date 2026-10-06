/**
 * Backend resolution for the REPL (M5).
 *
 * `env` uses the SDK's provider/API-key backend (unchanged). `pi` reuses pi's
 * own model registry and credential store so the REPL runs against the model
 * configured in pi, without asking for API keys or writing provider env vars.
 *
 * The pi packages are optional peers and loaded with a dynamic import only when
 * the pi backend is selected.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type {
  LLMBackend,
  LLMBackendMessage,
  LLMBackendRequest,
  LLMBackendResponse,
} from '../types.js';

export type BackendKind = 'env' | 'pi';

export interface PiBackendConfig {
  kind?: BackendKind;
  agentDir?: string;
  modelsPath?: string | null;
  authPath?: string | null;
  model?: string;
}

export interface ResolvedBackendPaths {
  agentDir: string;
  modelsPath: string;
  authPath: string;
  model?: string;
}

/** Minimal structural view of pi's ModelRegistry used by the adapter. */
export interface PiModelLike {
  provider: string;
  id: string;
  api?: string;
}

export interface PiCompletionRequest {
  systemPrompt?: string;
  messages: unknown[];
  tools?: unknown[];
}

export interface PiCompletionResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  >;
  usage: {
    input: number;
    output: number;
    totalTokens: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  };
  stopReason: 'stop' | 'toolUse' | 'length' | 'error' | 'aborted';
  errorMessage?: string;
}

export interface PiRegistryLike {
  getAvailable(): PiModelLike[];
  find?(provider: string, modelId: string): PiModelLike | undefined;
  hasConfiguredAuth(model: PiModelLike): boolean;
  complete(model: PiModelLike, context: PiCompletionRequest, options: unknown): Promise<PiCompletionResult>;
}

/** Resolve pi's agent dir, models.json, and auth.json paths. */
export function resolvePiPaths(
  config: PiBackendConfig,
  defaults: { agentDir: string },
): ResolvedBackendPaths {
  const agentDir = config.agentDir ?? defaults.agentDir;
  return {
    agentDir,
    modelsPath: config.modelsPath ?? path.join(agentDir, 'models.json'),
    authPath: config.authPath ?? path.join(agentDir, 'auth.json'),
    model: config.model,
  };
}

function modelLabel(model: PiModelLike): string {
  return `${model.provider}/${model.id}`;
}

/** Select the pi model to use, honoring an explicit provider/model request. */
export function selectPiModel(registry: PiRegistryLike, requested?: string): PiModelLike {
  const available = registry.getAvailable();
  if (available.length === 0) {
    throw new Error('pi has no configured models; run pi or `deepclause set-backend env`');
  }

  if (requested) {
    const normalized = requested.replace(':', '/');
    const [provider, ...rest] = normalized.split('/');
    const modelId = rest.join('/');
    if (modelId && registry.find) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
    const byId = available.find((model) => model.id === requested || modelLabel(model) === requested);
    if (byId) return byId;
    throw new Error(`pi model not found: ${requested}`);
  }

  return available[0];
}

function emptyUsage(): PiCompletionResult['usage'] {
  return { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function toPiMessages(messages: LLMBackendMessage[], model: PiModelLike): unknown[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'assistant' && message.providerData) {
        return message.providerData;
      }
      if (message.role === 'user') {
        return { role: 'user', content: message.content, timestamp: Date.now() };
      }
      if (message.role === 'tool') {
        return {
          role: 'toolResult',
          toolCallId: message.toolCallId ?? 'unknown',
          toolName: message.toolName ?? 'unknown',
          content: [{ type: 'text', text: message.content }],
          isError: false,
          timestamp: Date.now(),
        };
      }
      return {
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: 'toolCall',
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: message.toolCalls?.length ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
    });
}

/**
 * Wrap a pi registry + model as an SDK `LLMBackend`. Reused by the extension
 * embedding, which passes its live registry.
 */
export function createPiAdapter(
  registry: PiRegistryLike,
  model: PiModelLike,
  maxTokens = 65536,
): { backend: LLMBackend; modelId: string; provider: string } {
  if (!registry.hasConfiguredAuth(model)) {
    throw new Error(`pi has no configured authentication for ${modelLabel(model)}`);
  }

  const backend: LLMBackend = {
    async complete(request: LLMBackendRequest): Promise<LLMBackendResponse> {
      const systemPrompt = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');

      const response = await registry.complete(
        model,
        {
          systemPrompt: systemPrompt || undefined,
          messages: toPiMessages(request.messages, model),
          tools: request.tools?.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
        {
          signal: request.signal,
          maxTokens: request.maxTokens ?? maxTokens,
          cacheRetention: 'none',
        },
      );

      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage || `pi model request ${response.stopReason}`);
      }

      const text = response.content
        .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
        .map((content) => content.text)
        .join('');
      if (text) request.onText?.(text);

      return {
        text,
        toolCalls: response.content
          .filter((content): content is { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } => content.type === 'toolCall')
          .map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
        usage: {
          inputTokens: response.usage.input,
          outputTokens: response.usage.output,
          totalTokens: response.usage.totalTokens,
          cacheReadTokens: response.usage.cacheRead || undefined,
          cacheWriteTokens: response.usage.cacheWrite || undefined,
          reasoningTokens: response.usage.reasoning || undefined,
        },
        finishReason: response.stopReason === 'toolUse'
          ? 'tool_use'
          : response.stopReason === 'length'
            ? 'length'
            : 'stop',
        providerData: response,
      };
    },
  };

  return { backend, modelId: modelLabel(model), provider: model.provider };
}

interface PiModule {
  getAgentDir(): string;
  ModelRuntime: {
    create(options: { authPath?: string; modelsPath?: string; allowModelNetwork?: boolean }): Promise<unknown>;
  };
  ModelRegistry: new (runtime: unknown) => PiRegistryLike;
}

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

/** Walk up from a file until the pi package.json is found. */
function findPiPackageRoot(file: string): string | null {
  try {
    let dir = path.dirname(realpathSync(file));
    for (let i = 0; i < 12; i += 1) {
      const pkgPath = path.join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
          if (pkg.name === PI_PACKAGE_NAME) return dir;
        } catch {
          // ignore malformed package.json
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Locate the pi package from the `pi` executable on PATH. */
function findPiPackageRootOnPath(): string | null {
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const output = execFileSync(locator, ['pi'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = output.split(/\r?\n/)[0]?.trim();
    return first ? findPiPackageRoot(first) : null;
  } catch {
    return null;
  }
}

/** Candidate pi package roots for an existing (often global) install. */
function candidatePiPackageRoots(): string[] {
  const roots: string[] = [];
  if (process.env.PI_PACKAGE_DIR) roots.push(process.env.PI_PACKAGE_DIR);
  const onPath = findPiPackageRootOnPath();
  if (onPath) roots.push(onPath);

  // Peer dependency installed next to the SDK or in the current project.
  try {
    const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    roots.push(path.join(sdkRoot, 'node_modules', PI_PACKAGE_NAME));
  } catch {
    // ignore
  }
  roots.push(path.join(process.cwd(), 'node_modules', PI_PACKAGE_NAME));

  const home = process.env.HOME;
  if (home) {
    const piNodeDir = path.join(home, '.local', 'share', 'pi-node');
    if (existsSync(piNodeDir)) {
      try {
        for (const nodeDir of readdirSync(piNodeDir)) {
          roots.push(path.join(piNodeDir, nodeDir, 'lib', 'node_modules', PI_PACKAGE_NAME));
        }
      } catch {
        // ignore
      }
    }
    roots.push(path.join(home, '.npm-global', 'lib', 'node_modules', PI_PACKAGE_NAME));
  }

  roots.push(path.join('/usr/local/lib/node_modules', PI_PACKAGE_NAME));
  roots.push(path.join('/usr/lib/node_modules', PI_PACKAGE_NAME));
  return roots;
}

/**
 * Resolve the pi package entry file to an importable file URL.
 *
 * Used as a fallback when the bare specifier cannot be resolved (for example
 * when the SDK is `npm link`ed and therefore not co-located with a global pi
 * install), so `deepclause set-backend pi` works with an existing pi install.
 */
export function resolvePiPackageEntry(): string | null {
  for (const root of candidatePiPackageRoots()) {
    if (!root || !existsSync(root)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        name?: string;
        main?: string;
        exports?: Record<string, unknown>;
      };
      if (pkg.name !== PI_PACKAGE_NAME) continue;

      const exportEntry = pkg.exports?.['.'];
      let entry: string | undefined;
      if (typeof exportEntry === 'string') {
        entry = exportEntry;
      } else if (exportEntry && typeof exportEntry === 'object' && typeof (exportEntry as { import?: string }).import === 'string') {
        entry = (exportEntry as { import: string }).import;
      } else if (typeof pkg.main === 'string') {
        entry = pkg.main;
      } else {
        entry = path.join('dist', 'index.js');
      }

      const resolved = path.resolve(root, entry);
      if (existsSync(resolved)) {
        return pathToFileURL(resolved).href;
      }
    } catch {
      // ignore malformed candidates
    }
  }
  return null;
}

async function importPiModule(): Promise<PiModule> {
  // Typed as a plain string so TypeScript does not require the optional peer
  // dependency to be installed at build time.
  const packageName: string = PI_PACKAGE_NAME;
  try {
    return (await import(packageName)) as unknown as PiModule;
  } catch {
    // Fall back to an existing (often global) pi install located on disk. This
    // is what makes `deepclause set-backend pi` work with a plain `pi` install
    // even when the SDK is not co-located with it (e.g. `npm link`).
    const entry = resolvePiPackageEntry();
    if (entry) {
      try {
        return (await import(entry)) as unknown as PiModule;
      } catch {
        // fall through to the install hint
      }
    }
    throw new Error(
      "Backend 'pi' requires the optional peer dependency @earendil-works/pi-coding-agent. "
      + 'Install it, or run `deepclause set-backend env` to use the SDK provider/API-key backend.',
    );
  }
}

export interface CreatePiBackendOptions extends PiBackendConfig {
  maxTokens?: number;
  /** Injected registry (used by tests and by a pi embedding). */
  modelRegistry?: PiRegistryLike;
}

/** Structural view of pi's runtime used for setup/catalog operations. */
export interface PiRuntimeLike {
  getProviders(): Array<{
    id: string;
    name?: string;
    auth?: { apiKey?: unknown; oauth?: unknown };
  }>;
  getModels(providerId?: string): PiModelLike[];
  hasConfiguredAuth(providerId: string): boolean;
  getProviderAuthStatus(providerId: string): { configured: boolean; label?: string; source?: string };
  login(providerId: string, type: string, interaction: unknown, options?: unknown): Promise<unknown>;
}

export interface PiProviderInfo {
  id: string;
  name: string;
  apiKey: boolean;
  oauth: boolean;
  configured: boolean;
  source?: string;
  label?: string;
}

export interface PiModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiAuthPromptLike {
  signal?: AbortSignal;
  type: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>;
}

export interface PiAuthEventLike {
  type: 'info' | 'auth_url' | 'device_code' | 'progress';
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  links?: ReadonlyArray<{ url: string; label?: string }>;
}

export interface PiAuthInteractionLike {
  signal?: AbortSignal;
  prompt(prompt: PiAuthPromptLike): Promise<string>;
  notify(event: PiAuthEventLike): void;
}

/** List providers from a pi runtime with auth capability/status. */
export function listPiProviders(runtime: PiRuntimeLike): PiProviderInfo[] {
  return runtime.getProviders().map((provider) => {
    const status = runtime.getProviderAuthStatus(provider.id);
    return {
      id: provider.id,
      name: provider.name ?? provider.id,
      apiKey: Boolean(provider.auth?.apiKey),
      oauth: Boolean(provider.auth?.oauth),
      configured: status?.configured ?? runtime.hasConfiguredAuth(provider.id),
      source: status?.source,
      label: status?.label,
    };
  });
}

/** List chat models from a pi runtime, optionally filtered by provider. */
export function listPiModels(runtime: PiRuntimeLike, providerId?: string): PiModelInfo[] {
  return runtime.getModels(providerId).map((model) => ({
    provider: model.provider,
    id: model.id,
    name: (model as { name?: string }).name ?? model.id,
    reasoning: Boolean((model as { reasoning?: boolean }).reasoning),
    contextWindow: (model as { contextWindow?: number }).contextWindow,
    maxTokens: (model as { maxTokens?: number }).maxTokens,
  }));
}

/** A pi runtime handle: the model registry plus catalog/auth operations. */
export interface PiRuntimeHandle {
  registry: PiRegistryLike;
  runtime: PiRuntimeLike;
  listProviders(): PiProviderInfo[];
  listModels(providerId?: string): PiModelInfo[];
  hasAuth(providerId: string): boolean;
  login(providerId: string, interaction: PiAuthInteractionLike, type?: 'api_key' | 'oauth'): Promise<void>;
}

/** Whether the pi package can be imported (installed and resolvable). */
export function isPiPackageAvailable(): boolean {
  try {
    // Throws when neither the bare specifier nor a discovered path resolves.
    return resolvePiPackageEntry() !== null;
  } catch {
    return false;
  }
}

/**
 * Open a pi runtime using an existing install's credential store and model
 * catalog. This is the setup entry point used by `set-backend pi`; it does not
 * require the pi CLI or a pre-existing pi session.
 */
export async function openPiRuntime(
  options: CreatePiBackendOptions = {},
): Promise<PiRuntimeHandle> {
  const pi = await importPiModule();
  const paths = resolvePiPaths(options, { agentDir: pi.getAgentDir() });
  const runtime = (await pi.ModelRuntime.create({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    allowModelNetwork: false,
  })) as unknown as PiRuntimeLike;
  const registry = options.modelRegistry ?? new pi.ModelRegistry(runtime);

  return {
    registry,
    runtime,
    listProviders: () => listPiProviders(runtime),
    listModels: (providerId) => listPiModels(runtime, providerId),
    hasAuth: (providerId) => runtime.hasConfiguredAuth(providerId),
    login: async (providerId, interaction, type) => {
      const authType = type ?? 'api_key';
      await runtime.login(providerId, authType, interaction, {});
    },
  };
}

/**
 * Build an `LLMBackend` from pi's credential store. Throws a clear error when
 * the pi packages are not installed.
 */
export async function createPiBackend(options: CreatePiBackendOptions = {}): Promise<{
  backend: LLMBackend;
  modelId: string;
  provider: string;
}> {
  let registry = options.modelRegistry;
  let requested = options.model;

  if (!registry) {
    const pi = await importPiModule();
    const paths = resolvePiPaths(options, { agentDir: pi.getAgentDir() });
    requested = requested ?? paths.model;
    const runtime = await pi.ModelRuntime.create({
      authPath: paths.authPath,
      modelsPath: paths.modelsPath,
      allowModelNetwork: false,
    });
    registry = new pi.ModelRegistry(runtime);
  }

  const model = selectPiModel(registry, requested);
  return createPiAdapter(registry, model, options.maxTokens);
}
