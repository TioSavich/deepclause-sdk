/**
 * pi login/logout, ported to a plain terminal.
 *
 * This is the headless equivalent of pi's `/login`: enumerate providers with
 * their auth methods and configured status, run `runtime.login(provider, type,
 * interaction)` (which persists the credential), and render the auth
 * events (`auth_url`, `device_code`, `progress`, `info`) that the flow emits.
 *
 * The interaction is a superset of pi-ai's `AuthInteraction`; the shapes are
 * re-declared structurally so this module does not depend on pi-ai types.
 */

import * as readline from 'readline';

import type {
  PiAuthEventLike,
  PiAuthInteractionLike,
  PiRuntimeHandle,
} from './backend.js';

export interface LoginProviderOption {
  id: string;
  name: string;
  authType: 'oauth' | 'api_key';
  configured: boolean;
  source?: string;
  /** OAuth backed by a provider subscription rather than a direct account. */
  subscription: boolean;
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

function renderAuthEvent(event: PiAuthEventLike): void {
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
}

/** Port of pi's login dialog to a plain terminal (readline + stdout). */
export function createTerminalAuthInteraction(): PiAuthInteractionLike {
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
    notify: renderAuthEvent,
  };
}

/** Interaction that answers every prompt with a fixed API key. */
export function apiKeyInteraction(apiKey: string): PiAuthInteractionLike {
  return {
    prompt: async () => apiKey,
    notify: (event) => {
      if (event.message) console.log(event.message);
    },
  };
}

/**
 * Providers that support login, one entry per auth method (mirrors pi's
 * `getLoginProviderOptions`).
 */
export function listLoginProviders(
  handle: PiRuntimeHandle,
  options: { authType?: 'oauth' | 'api_key' } = {},
): LoginProviderOption[] {
  const status = new Map(handle.listProviders().map((provider) => [provider.id, provider]));
  const out: LoginProviderOption[] = [];
  for (const provider of handle.runtime.getProviders()) {
    const info = status.get(provider.id);
    const configured = info?.configured ?? handle.hasAuth(provider.id);
    const source = info?.label ?? info?.source;
    const subscription = provider.auth?.oauth?.isSubscription === true;
    const base = { id: provider.id, name: provider.name ?? provider.id, configured, source, subscription };
    if ((!options.authType || options.authType === 'oauth') && provider.auth?.oauth) {
      out.push({ ...base, authType: 'oauth' });
    }
    if ((!options.authType || options.authType === 'api_key') && provider.auth?.apiKey) {
      out.push({ ...base, authType: 'api_key' });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.authType.localeCompare(b.authType));
}

/**
 * Run pi's login for a provider. `type` selects the auth method when a provider
 * offers both; otherwise the only available method is used. `apiKey` short-
 * circuits the interaction.
 */
export async function loginToProvider(
  handle: PiRuntimeHandle,
  providerId: string,
  options: { interaction: PiAuthInteractionLike; type?: 'api_key' | 'oauth'; apiKey?: string },
): Promise<void> {
  if (options.apiKey) {
    await handle.login(providerId, apiKeyInteraction(options.apiKey), 'api_key');
    return;
  }
  const types = listLoginProviders(handle)
    .filter((provider) => provider.id === providerId)
    .map((provider) => provider.authType);
  const type = options.type ?? (types.includes('api_key') ? 'api_key' : types[0]);
  if (!type) {
    throw new Error(`provider '${providerId}' has no login method`);
  }
  await handle.login(providerId, options.interaction, type);
}

/** Remove a stored credential (pi `/logout`). */
export async function logoutProvider(handle: PiRuntimeHandle, providerId: string): Promise<void> {
  await handle.logout(providerId);
}
