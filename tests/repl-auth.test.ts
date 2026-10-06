/**
 * pi login/logout routing: provider enumeration and auth-method selection.
 */
import { describe, expect, it } from 'vitest';

import { listLoginProviders, loginToProvider, logoutProvider } from '../src/repl/auth.js';
import type { PiAuthInteractionLike } from '../src/repl/backend.js';
import type { PiRuntimeHandle } from '../src/repl/backend.js';

const NOOP_INTERACTION: PiAuthInteractionLike = {
  prompt: async () => '',
  notify: () => {},
};

function stubHandle(): {
  handle: PiRuntimeHandle;
  logins: Array<{ provider: string; type: string; key?: string }>;
  logouts: string[];
} {
  const logins: Array<{ provider: string; type: string; key?: string }> = [];
  const logouts: string[] = [];
  const handle = {
    registry: {},
    runtime: {
      getProviders: () => [
        { id: 'anthropic', name: 'Anthropic', auth: { apiKey: {}, oauth: { isSubscription: true } } },
        { id: 'openai', name: 'OpenAI', auth: { apiKey: {} } },
      ],
    },
    listProviders: () => [
      { id: 'anthropic', name: 'Anthropic', apiKey: true, oauth: true, configured: true, label: 'OAuth' },
      { id: 'openai', name: 'OpenAI', apiKey: true, oauth: false, configured: false },
    ],
    listModels: () => [],
    hasAuth: (id: string) => id === 'anthropic',
    isUsingOAuth: () => true,
    listCredentials: async () => [],
    login: async (provider: string, interaction: PiAuthInteractionLike, type?: string) => {
      const key = type === 'api_key' ? await interaction.prompt({ type: 'secret', message: 'key?' }) : undefined;
      logins.push({ provider, type: type ?? 'api_key', key });
    },
    logout: async (provider: string) => {
      logouts.push(provider);
    },
  } as unknown as PiRuntimeHandle;
  return { handle, logins, logouts };
}

describe('listLoginProviders', () => {
  it('lists one entry per auth method with configured status', () => {
    const { handle } = stubHandle();
    const providers = listLoginProviders(handle);
    expect(providers.map((provider) => `${provider.id}:${provider.authType}`)).toEqual([
      'anthropic:api_key',
      'anthropic:oauth',
      'openai:api_key',
    ]);
    expect(providers.find((provider) => provider.id === 'anthropic')?.configured).toBe(true);
    expect(providers.find((provider) => provider.id === 'anthropic')?.subscription).toBe(true);
    expect(providers.find((provider) => provider.id === 'openai')?.configured).toBe(false);
  });

  it('can filter to oauth providers', () => {
    const { handle } = stubHandle();
    expect(listLoginProviders(handle, { authType: 'oauth' }).map((provider) => provider.id)).toEqual(['anthropic']);
  });
});

describe('loginToProvider', () => {
  it('defaults to api_key when the provider offers it', async () => {
    const { handle, logins } = stubHandle();
    await loginToProvider(handle, 'anthropic', { interaction: NOOP_INTERACTION });
    expect(logins).toEqual([{ provider: 'anthropic', type: 'api_key', key: '' }]);
  });

  it('honours an explicit oauth request', async () => {
    const { handle, logins } = stubHandle();
    await loginToProvider(handle, 'anthropic', { interaction: NOOP_INTERACTION, type: 'oauth' });
    expect(logins).toEqual([{ provider: 'anthropic', type: 'oauth', key: undefined }]);
  });

  it('short-circuits with a supplied API key', async () => {
    const { handle, logins } = stubHandle();
    await loginToProvider(handle, 'openai', {
      interaction: { prompt: async () => 'sk-test', notify: () => {} },
      apiKey: 'sk-test',
    });
    expect(logins).toEqual([{ provider: 'openai', type: 'api_key', key: 'sk-test' }]);
  });

  it('rejects a provider without a login method', async () => {
    const { handle } = stubHandle();
    await expect(loginToProvider(handle, 'unknown', { interaction: NOOP_INTERACTION })).rejects.toThrow(/no login method/);
  });
});

describe('logoutProvider', () => {
  it('delegates to the runtime', async () => {
    const { handle, logouts } = stubHandle();
    await logoutProvider(handle, 'anthropic');
    expect(logouts).toEqual(['anthropic']);
  });
});
