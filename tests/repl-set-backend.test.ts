/**
 * M5/M7 — `set-backend pi` setup helpers: model selection and pi login routing.
 */
import { describe, expect, it } from 'vitest';

import { choosePiModel, ensurePiAuth } from '../src/cli/set-backend.js';
import type {
  PiModelInfo,
  PiProviderInfo,
  PiRuntimeHandle,
} from '../src/repl/backend.js';
import type { PiRegistryLike } from '../src/repl/backend.js';

const MODELS: PiModelInfo[] = [
  { provider: 'acme', id: 'small', name: 'Small', reasoning: false },
  { provider: 'acme', id: 'large', name: 'Large', reasoning: true },
];

function stubHandle(options: {
  models?: PiModelInfo[];
  providers?: PiProviderInfo[];
  configured?: boolean;
  onLogin?: (provider: string, type: string, interaction: unknown) => void;
} = {}): PiRuntimeHandle {
  const models = options.models ?? MODELS;
  const providers = options.providers ?? [{
    id: 'acme',
    name: 'Acme',
    apiKey: true,
    oauth: true,
    configured: options.configured ?? true,
  }];
  const configured = options.configured ?? true;
  const registry = {
    getAvailable: () => models.map((model) => ({ provider: model.provider, id: model.id })),
    find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: () => configured,
    complete: async () => ({ content: [], usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: 'stop' as const }),
  } as PiRegistryLike;

  return {
    registry,
    runtime: {} as PiRuntimeHandle['runtime'],
    listProviders: () => providers,
    listModels: (providerId) => (providerId ? models.filter((model) => model.provider === providerId) : models),
    hasAuth: () => configured,
    login: async (provider, _interaction, type) => {
      options.onLogin?.(provider, type ?? 'api_key', _interaction);
    },
  };
}

describe('choosePiModel', () => {
  it('resolves an explicit provider/model request', async () => {
    const model = await choosePiModel(stubHandle(), { model: 'acme/large' });
    expect(model).toMatchObject(MODELS[1]);
  });

  it('accepts a bare model id', async () => {
    const model = await choosePiModel(stubHandle(), { model: 'small' });
    expect(model.id).toBe('small');
  });

  it('rejects an unknown model', async () => {
    await expect(choosePiModel(stubHandle(), { model: 'acme/nope' })).rejects.toThrow(/not found/);
  });

  it('returns the only model without prompting', async () => {
    const only = [MODELS[0]];
    const model = await choosePiModel(stubHandle({ models: only }), {});
    expect(model).toEqual(MODELS[0]);
  });

  it('fails clearly when several models exist and stdin is not a TTY', async () => {
    await expect(choosePiModel(stubHandle(), {})).rejects.toThrow(/multiple pi models/);
  });

  it('filters the catalog by provider', async () => {
    await expect(choosePiModel(stubHandle({ models: [] }), { provider: 'other' })).rejects.toThrow(/no pi models/);
  });
});

describe('ensurePiAuth', () => {
  it('does nothing when the provider is already configured', async () => {
    let logins = 0;
    await ensurePiAuth(stubHandle({ configured: true, onLogin: () => { logins += 1; } }), 'acme', {});
    expect(logins).toBe(0);
  });

  it('stores a supplied API key through pi login', async () => {
    let captured: { provider: string; type: string; key: string } | null = null;
    const handle = stubHandle({ configured: false });
    handle.login = async (provider, interaction, type) => {
      const key = await interaction.prompt({ type: 'secret', message: 'key?' });
      captured = { provider, type: type ?? 'api_key', key };
    };

    await ensurePiAuth(handle, 'acme', { apiKey: 'sk-test' });
    expect(captured).toEqual({ provider: 'acme', type: 'api_key', key: 'sk-test' });
  });

  it('fails with guidance in non-interactive runs without a key', async () => {
    await expect(ensurePiAuth(stubHandle({ configured: false }), 'acme', {})).rejects.toThrow(/no credentials/);
  });

  it('honours --no-login', async () => {
    await expect(
      ensurePiAuth(stubHandle({ configured: false }), 'acme', { login: false }),
    ).rejects.toThrow(/no credentials/);
  });
});
