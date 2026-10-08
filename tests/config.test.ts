/**
 * Config module: init/load/validate/update and the model-id helpers.
 *
 * The filesystem is replaced with memfs so nothing touches the real disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';

import {
  configExists,
  ensureWorkspaceDocSeeds,
  formatModelString,
  getConfigDir,
  getConfigPath,
  getDocsDir,
  getMCPServers,
  getSystemDir,
  getToolsDir,
  initConfig,
  loadConfig,
  parseModelString,
  setModel,
  showModel,
  updateConfig,
  validateConfig,
} from '../src/cli/config.js';

vi.mock('fs/promises', async () => {
  const memfs = await import('memfs');
  return memfs.fs.promises;
});

const WS = '/workspace';
const configFile = `${WS}/.deepclause/config.json`;

function readConfig(): Record<string, unknown> {
  return JSON.parse(vol.readFileSync(configFile, 'utf8') as string) as Record<string, unknown>;
}

describe('Config Module', () => {
  beforeEach(() => {
    vol.reset();
  });

  afterEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it('roots every workspace path under .deepclause', () => {
    expect(getConfigDir(WS)).toBe(`${WS}/.deepclause`);
    expect(getConfigPath(WS)).toBe(configFile);
    expect(getDocsDir(WS)).toBe(`${WS}/.deepclause/docs`);
    expect(getToolsDir(WS)).toBe(`${WS}/.deepclause/tools`);
    expect(getSystemDir(WS)).toBe(`${WS}/.deepclause/system`);
  });

  it('configExists reflects whether initConfig has run', async () => {
    expect(await configExists(WS)).toBe(false);
    await initConfig(WS);
    expect(await configExists(WS)).toBe(true);
  });

  it('initConfig writes a valid default config and seeds assets', async () => {
    await initConfig(WS);

    const raw = readConfig();
    expect(raw.models).toMatchObject({ run: 'openai:gpt-4o' });
    const config = validateConfig(raw);
    expect(config.backend.kind).toBe('pi');
    expect(config.shell.wrapper).toBe('auto');

    expect(vol.existsSync(`${WS}/.deepclause/.gitignore`)).toBe(true);
    expect(vol.existsSync(`${WS}/.deepclause/tools`)).toBe(true);
    expect(vol.existsSync(`${WS}/.deepclause/docs/DML_REFERENCE.md`)).toBe(true);
    expect(vol.existsSync(`${WS}/.deepclause/docs/DML_AUTHORING.md`)).toBe(true);
    expect(vol.existsSync(`${WS}/.deepclause/system`)).toBe(true);
  });

  it('initConfig refuses to clobber an existing config without force', async () => {
    await initConfig(WS);
    await expect(initConfig(WS)).rejects.toThrow(/already exists/i);
    await initConfig(WS, { force: true });
  });

  it('initConfig honors a custom model', async () => {
    await initConfig(WS, { model: 'anthropic/claude-3-opus' });
    expect((readConfig().models as Record<string, string>).run).toBe('anthropic:claude-3-opus');
  });

  it('loadConfig throws a helpful error before init', async () => {
    await expect(loadConfig(WS)).rejects.toThrow(/Run 'deepclause init'/);
  });

  it('loadConfig backfills docs/system and returns a validated config', async () => {
    await initConfig(WS);
    vol.rmSync(`${WS}/.deepclause/docs`, { recursive: true, force: true });
    const config = await loadConfig(WS);
    expect(config.models.run).toBe('openai:gpt-4o');
    expect(vol.existsSync(`${WS}/.deepclause/docs/DML_REFERENCE.md`)).toBe(true);
  });

  it('validateConfig fills defaults and rejects invalid values', () => {
    const config = validateConfig({});
    expect(config.models.run).toBe('openai:gpt-4o');
    expect(config.temperatures.run).toBe(0.7);
    expect(config.repl.maxModelCalls).toBe(100);
    expect(() => validateConfig({ temperatures: { run: 'hot' } })).toThrow(/Invalid configuration/);
    expect(() => validateConfig({ backend: { kind: 'nope' } })).toThrow(/Invalid configuration/);
  });

  it('parseModelString normalizes to the canonical provider:model form', () => {
    expect(parseModelString('anthropic/claude-3-opus')).toBe('anthropic:claude-3-opus');
    expect(parseModelString('openai:gpt-4o')).toBe('openai:gpt-4o');
    expect(parseModelString('openai/gpt-4o')).toBe('openai:gpt-4o');
    expect(parseModelString('gpt-4-turbo')).toBe('openai:gpt-4-turbo');
    expect(parseModelString('o1-preview')).toBe('openai:o1-preview');
    expect(parseModelString('claude-3-sonnet')).toBe('anthropic:claude-3-sonnet');
    expect(parseModelString('gemini-pro')).toBe('google:gemini-pro');
    expect(parseModelString('some-other-model')).toBe('openrouter:some-other-model');
    expect(() => parseModelString('')).toThrow(/cannot be empty/i);
  });

  it('formatModelString returns the canonical id', () => {
    expect(formatModelString('openai:gpt-4o')).toBe('openai:gpt-4o');
    expect(formatModelString('anthropic/claude-3-opus')).toBe('anthropic:claude-3-opus');
  });

  it('setModel updates every slot by default and reports the result', async () => {
    await initConfig(WS);

    const result = await setModel(WS, 'anthropic/claude-3-opus');
    expect(result.modelId).toBe('anthropic:claude-3-opus');
    expect(result.updatedSlots).toEqual(['gateway', 'run', 'compile']);
    expect(result.info).toContain('anthropic:claude-3-opus');

    const config = await loadConfig(WS);
    expect(config.models).toMatchObject({
      gateway: 'anthropic:claude-3-opus',
      run: 'anthropic:claude-3-opus',
      compile: 'anthropic:claude-3-opus',
    });
  });

  it('setModel can target a single slot', async () => {
    await initConfig(WS);

    const result = await setModel(WS, 'gemini-2.0-flash', 'run');
    expect(result.updatedSlots).toEqual(['run']);

    const config = await loadConfig(WS);
    expect(config.models.run).toBe('google:gemini-2.0-flash');
    expect(config.models.gateway).toBe('openai:gpt-4o');
  });

  it('showModel reports per-slot models and temperatures', async () => {
    await initConfig(WS);
    await setModel(WS, 'anthropic/claude-3-opus');

    const shown = await showModel(WS);
    expect(shown.models.run).toBe('anthropic:claude-3-opus');
    expect(shown.temperatures.run).toBe(0.7);
    expect(shown.formatted).toContain('run: anthropic:claude-3-opus');
  });

  it('updateConfig deep-merges and validates the result', async () => {
    await initConfig(WS);

    const updated = await updateConfig(WS, {
      repl: { maxModelCalls: 42 },
      models: { run: 'google:gemini-pro' },
    } as never);

    expect(updated.repl.maxModelCalls).toBe(42);
    expect(updated.models.run).toBe('google:gemini-pro');
    // Untouched slots survive the merge.
    expect(updated.models.gateway).toBe('openai:gpt-4o');
  });

  it('getMCPServers returns the configured servers', () => {
    const config = validateConfig({ mcp: { servers: { local: { command: 'run.sh' } } } });
    expect(getMCPServers(config).local).toMatchObject({ command: 'run.sh' });
  });

  it('ensureWorkspaceDocSeeds does not overwrite an existing doc', async () => {
    vol.mkdirSync(`${WS}/.deepclause/docs`, { recursive: true });
    vol.writeFileSync(`${WS}/.deepclause/docs/DML_REFERENCE.md`, 'custom content');

    await ensureWorkspaceDocSeeds(WS);

    expect(vol.readFileSync(`${WS}/.deepclause/docs/DML_REFERENCE.md`, 'utf8')).toBe('custom content');
  });
});
