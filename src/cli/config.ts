/**
 * DeepClause CLI Configuration Module
 * 
 * Handles configuration loading, validation, and management.
 */

import { z } from 'zod';
import { readFileSync, readdirSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureDefaultSkillSeeds, writeDefaultSkillSeeds } from './default-skills.js';
import {
  getSystemCompactorAssetPath,
  getPackagedRecipeAssetsDir,
  getSystemPromptAssetPath,
  getSystemSkillAssetPath,
  getWorkspaceDocAssetPath,
  getWorkspaceRecipeAssetsDir,
} from '../system/assets/index.js';
import type { CompactionOptions } from '../types.js';
import {
  DEFAULT_MODEL_IDS,
  DEFAULT_TEMPERATURES,
  buildModelOverride,
  formatModelId,
  normalizeModelId,
  resolveModelSlotConfig,
  type ModelSlot,
  type Provider,
  type ResolvedModelConfig,
} from '../system/config/model-slots.js';

export type { ModelSlot, Provider, ResolvedModelConfig } from '../system/config/model-slots.js';
export { buildModelOverride } from '../system/config/model-slots.js';

// =============================================================================
// Configuration Schema
// =============================================================================

const MCPServerSchema = z.object({
  command: z.string().min(1, 'MCP server command is required'),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string()).optional().default({})
});

const MCPConfigSchema = z.object({
  servers: z.record(MCPServerSchema).optional().default({})
});

const AgentVMConfigSchema = z.object({
  /** Enable networking in the VM (default: false for security) */
  network: z.boolean().optional().default(false)
}).optional().default({ network: false });

const ShellConfigSchema = z.object({
  wrapper: z.enum(['auto', 'clean-room', 'bwrap', 'sandbox-exec']).optional().default('auto'),
  strictIsolation: z.boolean().optional().default(false),
}).optional().default({ wrapper: 'auto', strictIsolation: false });

const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional()
});

const ProvidersSchema = z.object({
  openai: ProviderConfigSchema.optional(),
  anthropic: ProviderConfigSchema.optional(),
  google: ProviderConfigSchema.optional(),
  openrouter: ProviderConfigSchema.optional()
}).optional().default({});

const ToolPolicySchema = z.object({
  mode: z.enum(['whitelist', 'blacklist']),
  tools: z.array(z.string()).default([]),
});

const CompactorDefinitionSchema = z.object({
  source: z.string().min(1, 'DML compactor source is required'),
  sourceType: z.enum(['inline', 'file', 'auto']).optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  gasLimit: z.number().int().positive().optional(),
  model: z.string().min(1).optional(),
  provider: z.enum(['openai', 'anthropic', 'google', 'openrouter']).optional(),
  inheritTools: z.boolean().optional(),
  toolPolicy: ToolPolicySchema.nullish(),
});

const CompactorBindingSchema = z.object({
  name: z.string().min(1).optional(),
  scope: z.enum(['session', 'loop', 'run']),
  trigger: z.enum(['before_user_message', 'before_model_call', 'before_task', 'after_task']),
  compactor: CompactorDefinitionSchema,
});

const CompactionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  bindings: z.array(CompactorBindingSchema).optional(),
}).optional();

const ModelsSchema = z.object({
  gateway: z.string().min(1).default(DEFAULT_MODEL_IDS.gateway),
  run: z.string().min(1).default(DEFAULT_MODEL_IDS.run),
  compile: z.string().min(1).default(DEFAULT_MODEL_IDS.compile),
});

const TemperaturesSchema = z.object({
  gateway: z.number().min(0).max(2).default(DEFAULT_TEMPERATURES.gateway),
  run: z.number().min(0).max(2).default(DEFAULT_TEMPERATURES.run),
  compile: z.number().min(0).max(2).default(DEFAULT_TEMPERATURES.compile),
});

const ModelSlotOverridesSchema = z.object({
  maxContextTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoningEffort: z.string().optional(),
});

const ModelOptionsSchema = z.object({
  gateway: ModelSlotOverridesSchema.optional(),
  run: ModelSlotOverridesSchema.optional(),
  compile: ModelSlotOverridesSchema.optional(),
}).optional().default({});

/**
 * DML REPL settings. All optional; see docs/DML_REPL_PROPOSAL.md §13.4.
 */
const ReplConfigSchema = z.object({
  exportOnExit: z.boolean().optional().default(false),
  exportPath: z.string().optional().default('harness.dml'),
  frozen: z.boolean().optional().default(false),
  locked: z.boolean().optional().default(false),
  editMode: z.enum(['transactional', 'direct']).optional().default('transactional'),
  maxDepth: z.number().int().positive().optional().default(3),
  maxModelCalls: z.number().int().positive().optional().default(24),
  writeDepth: z.number().int().positive().optional().default(20),
  repairRounds: z.number().int().nonnegative().optional().default(1),
  promptPrefix: z.string().optional().default('dml> '),
  render: z.enum(['rich', 'plain', 'json']).optional(),
  showReasoning: z.enum(['off', 'summary', 'full']).optional().default('summary'),
  showToolArgs: z.boolean().optional().default(true),
  maxToolResultChars: z.number().int().positive().optional().default(2000),
  color: z.boolean().optional().default(true),
  tools: z.array(z.string()).nullish(),
}).optional().default({});

/**
 * Model backend selection. `env` uses the SDK provider/API-key settings;
 * `pi` reuses pi's model registry and credentials.
 */
const BackendConfigSchema = z.object({
  kind: z.enum(['env', 'pi']).optional().default('env'),
  agentDir: z.string().optional(),
  modelsPath: z.string().nullish(),
  authPath: z.string().nullish(),
  model: z.string().optional(),
}).optional().default({ kind: 'env' });

export const ConfigSchema = z.object({
  models: ModelsSchema.default(DEFAULT_MODEL_IDS),
  backend: BackendConfigSchema,
  temperatures: TemperaturesSchema.default(DEFAULT_TEMPERATURES),
  modelOptions: ModelOptionsSchema,
  providers: ProvidersSchema,
  mcp: MCPConfigSchema.optional().default({ servers: {} }),
  agentvm: AgentVMConfigSchema,
  shell: ShellConfigSchema,
  compaction: CompactionConfigSchema,
  repl: ReplConfigSchema,
  dmlBase: z.string().optional().default('.deepclause/tools'),
  workspace: z.string().optional().default('./'),
  model: z.string().optional(),
  provider: z.enum(['openai', 'anthropic', 'google', 'openrouter']).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type MCPServer = z.infer<typeof MCPServerSchema>;

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: Config = {
  models: { ...DEFAULT_MODEL_IDS },
  temperatures: { ...DEFAULT_TEMPERATURES },
  modelOptions: {},
  backend: { kind: 'env' },
  providers: {},
  mcp: { servers: {} },
  agentvm: { network: false },
  shell: { wrapper: 'auto', strictIsolation: false },
  compaction: {
    enabled: true,
    bindings: [
      {
        name: 'default-session',
        scope: 'session',
        trigger: 'before_user_message',
        compactor: {
          source: '.deepclause/system/default-session-compactor.dml',
          sourceType: 'file',
          timeoutMs: 15_000,
          inheritTools: false,
        },
      },
      {
        name: 'default-loop',
        scope: 'loop',
        trigger: 'before_model_call',
        compactor: {
          source: '.deepclause/system/default-loop-compactor.dml',
          sourceType: 'file',
          timeoutMs: 15_000,
          inheritTools: false,
        },
      },
    ],
  },
  repl: {
    exportOnExit: false,
    exportPath: 'harness.dml',
    frozen: false,
    locked: false,
    editMode: 'transactional',
    maxDepth: 3,
    maxModelCalls: 24,
    writeDepth: 20,
    repairRounds: 1,
    promptPrefix: 'dml> ',
    showReasoning: 'summary',
    showToolArgs: true,
    maxToolResultChars: 2000,
    color: true,
  },
  dmlBase: '.deepclause/tools',
  workspace: './'
};

// =============================================================================
// Configuration Paths
// =============================================================================

export function getConfigDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.deepclause');
}

export function getConfigPath(workspaceRoot: string): string {
  return path.join(getConfigDir(workspaceRoot), 'config.json');
}

export function getToolsDir(workspaceRoot: string): string {
  return path.join(getConfigDir(workspaceRoot), 'tools');
}

export function getSystemDir(workspaceRoot: string): string {
  return path.join(getConfigDir(workspaceRoot), 'system');
}

export function getDocsDir(workspaceRoot: string): string {
  return path.join(getConfigDir(workspaceRoot), 'docs');
}

// =============================================================================
// Configuration Operations
// =============================================================================

/**
 * Initialize DeepClause configuration in a workspace
 */
export async function initConfig(
  workspaceRoot: string,
  options: { force?: boolean; model?: string } = {}
): Promise<void> {
  const configDir = getConfigDir(workspaceRoot);
  const configPath = getConfigPath(workspaceRoot);
  const toolsDir = getToolsDir(workspaceRoot);
  const systemDir = getSystemDir(workspaceRoot);
  const docsDir = getDocsDir(workspaceRoot);

  // Check for existing config
  try {
    await fs.access(configPath);
    if (!options.force) {
      throw new Error(
        'Configuration already exists. Use --force to overwrite.'
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // Create directories
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(toolsDir, { recursive: true });
  await fs.mkdir(systemDir, { recursive: true });
  await fs.mkdir(docsDir, { recursive: true });

  // Create config with optional model override
  const initialModelId = options.model ? normalizeModelId(options.model) : DEFAULT_MODEL_IDS.run;
  const config: Config = {
    ...DEFAULT_CONFIG,
    models: {
      gateway: initialModelId,
      run: initialModelId,
      compile: initialModelId,
    },
  };

  // Write config
  await fs.writeFile(configPath, serializeConfig(config));

  // Create .gitignore for the .deepclause directory
  const gitignorePath = path.join(configDir, '.gitignore');
  const gitignoreContent = `# DeepClause generated files
*.meta.json

# Keep tools directory but ignore compiled files by default
# Uncomment to track compiled DML:
# !tools/*.dml
`;
  await fs.writeFile(gitignorePath, gitignoreContent);

  await writeDefaultSkillSeeds(toolsDir, initialModelId);
  await ensureSystemOverrideSeeds(workspaceRoot, { overwrite: true });
  await writeRecipeSeeds(workspaceRoot, { overwrite: true });
  await ensureWorkspaceDocSeeds(workspaceRoot, { overwrite: true });
}

export async function ensureSystemOverrideSeeds(
  workspaceRoot: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const systemDir = getSystemDir(workspaceRoot);
  await fs.mkdir(systemDir, { recursive: true });
  await copySystemOverrideSeeds(systemDir, options.overwrite ?? false);
}

async function copySystemOverrideSeeds(systemDir: string, overwrite: boolean): Promise<void> {
  const packagedAssets = [
    {
      fileName: 'conductor.dml',
      content: readFileSync(getSystemSkillAssetPath('conductor'), 'utf8'),
    },
    {
      fileName: 'skill-creator.dml',
      content: readFileSync(getSystemSkillAssetPath('skill-creator'), 'utf8'),
    },
    {
      fileName: 'plan.dml',
      content: readFileSync(getSystemSkillAssetPath('plan'), 'utf8'),
    },
    {
      fileName: 'deep-planner.dml',
      content: readFileSync(getSystemSkillAssetPath('deep-planner'), 'utf8'),
    },
    {
      fileName: 'security-planner.dml',
      content: readFileSync(getSystemSkillAssetPath('security-planner'), 'utf8'),
    },
    {
      fileName: 'CONDUCTOR_PROMPT.md',
      content: readFileSync(getSystemPromptAssetPath('conductor'), 'utf8'),
    },
    {
      fileName: 'DML_COMPILER_PROMPT.md',
      content: readFileSync(getSystemPromptAssetPath('skill-creator'), 'utf8'),
    },
    {
      fileName: 'TASK_PROMPT.md',
      content: readFileSync(getSystemPromptAssetPath('task'), 'utf8'),
    },
    {
      fileName: 'default-session-compactor.dml',
      content: readFileSync(getSystemCompactorAssetPath('default-session-compactor'), 'utf8'),
    },
    {
      fileName: 'default-loop-compactor.dml',
      content: readFileSync(getSystemCompactorAssetPath('default-loop-compactor'), 'utf8'),
    },
  ];

  await Promise.all(packagedAssets.map(async ({ fileName, content }) => {
    const filePath = path.join(systemDir, fileName);
    if (!overwrite) {
      try {
        await fs.access(filePath);
        return;
      } catch {
        // Seed the packaged system file when it is missing.
      }
    }
    await fs.writeFile(filePath, content, 'utf8');
  }));
}

async function writeRecipeSeeds(
  workspaceRoot: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const sourceRoot = getPackagedRecipeAssetsDir();
  const targetRoot = getWorkspaceRecipeAssetsDir(workspaceRoot);
  await fs.mkdir(targetRoot, { recursive: true });
  await copyRecipeSeedDirectory(sourceRoot, targetRoot, options.overwrite ?? false);
}

async function copyRecipeSeedDirectory(
  sourceDir: string,
  targetDir: string,
  overwrite: boolean,
): Promise<void> {
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(targetPath, { recursive: true });
      await copyRecipeSeedDirectory(sourcePath, targetPath, overwrite);
      continue;
    }

    if (!overwrite) {
      try {
        await fs.access(targetPath);
        continue;
      } catch {
        // Seed the packaged recipe file when it is missing.
      }
    }

    await fs.writeFile(targetPath, readFileSync(sourcePath, 'utf8'), 'utf8');
  }
}

export async function ensureWorkspaceDocSeeds(
  workspaceRoot: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const docsDir = getDocsDir(workspaceRoot);
  await fs.mkdir(docsDir, { recursive: true });
  await copyWorkspaceDocSeeds(docsDir, options.overwrite ?? false);
}

async function copyWorkspaceDocSeeds(docsDir: string, overwrite: boolean): Promise<void> {
  const packagedDocs = [
    {
      fileName: 'TUI.md',
      content: readFileSync(getWorkspaceDocAssetPath('tui'), 'utf8'),
    },
    {
      fileName: 'DML_REFERENCE.md',
      content: readFileSync(getWorkspaceDocAssetPath('dml-reference'), 'utf8'),
    },
  ];

  await Promise.all(packagedDocs.map(async ({ fileName, content }) => {
    const filePath = path.join(docsDir, fileName);
    if (!overwrite) {
      try {
        await fs.access(filePath);
        return;
      } catch {
        // Seed the packaged doc when it is missing.
      }
    }
    await fs.writeFile(filePath, content, 'utf8');
  }));
}

/**
 * Load and validate configuration
 */
export async function loadConfig(workspaceRoot: string): Promise<Config> {
  const configPath = getConfigPath(workspaceRoot);

  let rawConfig: unknown;
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    rawConfig = JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Configuration not found at ${configPath}. Run 'deepclause init' first.`
      );
    }
    throw new Error(`Failed to read config: ${(error as Error).message}`);
  }

  // Resolve environment variables in config
  const resolvedConfig = resolveEnvVars(rawConfig);
  const migratedConfig = migrateLegacyConfig(resolvedConfig);

  // Validate
  const config = validateConfig(migratedConfig);
  await ensureSystemOverrideSeeds(workspaceRoot);
  await ensureDefaultSkillSeeds(getToolsDir(workspaceRoot), config.models.run);
  await ensureWorkspaceDocSeeds(workspaceRoot);
  return config;
}

/**
 * Validate configuration object
 */
export function validateConfig(config: unknown): Config {
  const result = ConfigSchema.safeParse(config);
  
  if (!result.success) {
    const errors = result.error.issues
      .map(issue => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  return {
    ...result.data,
    models: {
      gateway: normalizeModelId(result.data.models.gateway),
      run: normalizeModelId(result.data.models.run),
      compile: normalizeModelId(result.data.models.compile),
    },
  };
}

/**
 * Parse a model string in either canonical provider:model form, legacy provider/model form,
 * or just model name form.
 */
export function parseModelString(modelString: string): string {
  return normalizeModelId(modelString);
}

/**
 * Format a model id as canonical provider:model
 */
export function formatModelString(modelId: string): string {
  return formatModelId(modelId);
}

/**
 * Set the default model in configuration.
 * When slot is omitted, all slots are updated for backward compatibility.
 */
export async function setModel(
  workspaceRoot: string,
  modelString: string,
  slot?: ModelSlot,
): Promise<{ modelId: string; updatedSlots: ModelSlot[]; info: string }> {
  const modelId = parseModelString(modelString);

  const config = await loadConfig(workspaceRoot);
  const updatedSlots: ModelSlot[] = slot ? [slot] : ['gateway', 'run', 'compile'];
  for (const nextSlot of updatedSlots) {
    config.models[nextSlot] = modelId;
  }

  const configPath = getConfigPath(workspaceRoot);
  await fs.writeFile(configPath, serializeConfig(config));

  const resolved = resolveModelSlotConfig(config, updatedSlots[0]);
  const infoLines: string[] = [];
  infoLines.push(`Model set: ${modelId} (${updatedSlots.join(', ')} slot${updatedSlots.length > 1 ? 's' : ''})`);
  if (resolved.contextWindow) {
    infoLines.push(`  Context window: ${resolved.contextWindow.toLocaleString()} tokens`);
  }
  if (resolved.maxOutputTokens) {
    infoLines.push(`  Max output:     ${resolved.maxOutputTokens.toLocaleString()} tokens`);
  }
  infoLines.push(`  Reasoning:      ${resolved.reasoning ? 'yes' : 'no'}${resolved.reasoningType && resolved.reasoningType !== 'none' ? ` (${resolved.reasoningType})` : ''}`);
  infoLines.push(`  Complexity:     ${resolved.complexity ?? 'unknown'}`);

  return { modelId, updatedSlots, info: infoLines.join('\n') };
}

/**
 * Get the current model configuration from configuration
 */
export async function showModel(workspaceRoot: string): Promise<{
  models: Record<ModelSlot, string>;
  temperatures: Record<ModelSlot, number>;
  formatted: string;
}> {
  const config = await loadConfig(workspaceRoot);
  const lines = (['gateway', 'run', 'compile'] as ModelSlot[]).map((slotName) => {
    const modelId = formatModelString(config.models[slotName]);
    const temperature = config.temperatures[slotName];
    const resolved = resolveModelSlotConfig(config, slotName);
    const ctx = resolved.contextWindow ? `${resolved.contextWindow.toLocaleString()}` : 'unknown';
    const out = resolved.maxOutputTokens ? `${resolved.maxOutputTokens.toLocaleString()}` : 'unknown';
    const reasoning = resolved.reasoning ? 'yes' : 'no';
    const complexity = resolved.complexity ?? 'unknown';
    return `${slotName}: ${modelId} (temp=${temperature}, ctx=${ctx}, out=${out}, reasoning=${reasoning}, complexity=${complexity})`;
  });

  return {
    models: { ...config.models },
    temperatures: { ...config.temperatures },
    formatted: lines.join('\n'),
  };
}

export function resolveModelSlot(
  config: Config,
  slot: ModelSlot,
  overrides: { modelId?: string; temperature?: number } = {},
): ResolvedModelConfig {
  return resolveModelSlotConfig(config, slot, overrides);
}

export function applyResolvedModelConfig(selection: ResolvedModelConfig): void {
  if (!selection.apiKey) {
    return;
  }

  switch (selection.provider) {
    case 'openai':
      process.env.OPENAI_API_KEY = selection.apiKey;
      break;
    case 'anthropic':
      process.env.ANTHROPIC_API_KEY = selection.apiKey;
      break;
    case 'google':
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = selection.apiKey;
      break;
    case 'openrouter':
      process.env.OPENROUTER_API_KEY = selection.apiKey;
      break;
  }
}

export function getDefaultConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    models: { ...DEFAULT_CONFIG.models },
    temperatures: { ...DEFAULT_CONFIG.temperatures },
    providers: { ...DEFAULT_CONFIG.providers },
    backend: { ...DEFAULT_CONFIG.backend },
    mcp: { servers: {} },
    agentvm: { network: DEFAULT_CONFIG.agentvm?.network ?? false },
    shell: { ...DEFAULT_CONFIG.shell },
    repl: { ...DEFAULT_CONFIG.repl },
    compaction: DEFAULT_CONFIG.compaction
      ? {
        ...DEFAULT_CONFIG.compaction,
        bindings: DEFAULT_CONFIG.compaction.bindings
          ? DEFAULT_CONFIG.compaction.bindings.map((binding) => ({
            ...binding,
            compactor: { ...binding.compactor },
          }))
          : undefined,
      }
      : undefined,
  };
}

/**
 * Update configuration with partial changes
 */
export async function updateConfig(
  workspaceRoot: string,
  updates: Partial<Config>
): Promise<Config> {
  const config = await loadConfig(workspaceRoot);
  const updated = {
    ...config,
    ...updates,
    models: { ...config.models, ...updates.models },
    temperatures: { ...config.temperatures, ...updates.temperatures },
    providers: { ...config.providers, ...updates.providers },
    mcp: updates.mcp ? { ...config.mcp, ...updates.mcp } : config.mcp,
    agentvm: updates.agentvm ? { ...config.agentvm, ...updates.agentvm } : config.agentvm,
    shell: updates.shell ? { ...config.shell, ...updates.shell } : config.shell,
    compaction: updates.compaction
      ? {
        ...config.compaction,
        ...updates.compaction,
        bindings: updates.compaction.bindings ?? config.compaction?.bindings,
      }
      : config.compaction,
  };
  
  // Re-validate
  const validated = validateConfig(updated);

  const configPath = getConfigPath(workspaceRoot);
  await fs.writeFile(configPath, serializeConfig(validated));

  return validated;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve environment variable references in configuration
 * Supports ${VAR_NAME} and $VAR_NAME syntax
 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    // Replace ${VAR} or $VAR patterns
    return obj.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/gi, (match, braced, plain) => {
      const varName = braced || plain;
      const value = process.env[varName];
      if (value === undefined) {
        // Return original if not found - allows for optional env vars
        return match;
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }

  return obj;
}

function migrateLegacyConfig(config: unknown): unknown {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return config;
  }

  const record = { ...(config as Record<string, unknown>) };
  const legacyModel = typeof record.model === 'string' ? record.model : undefined;
  const legacyProvider = typeof record.provider === 'string' ? record.provider as Provider : undefined;
  const legacyModelId = legacyModel ? buildModelOverride(legacyModel, legacyProvider) : undefined;

  const rawModels = record.models && typeof record.models === 'object' && !Array.isArray(record.models)
    ? record.models as Record<string, unknown>
    : {};
  const rawTemperatures = record.temperatures && typeof record.temperatures === 'object' && !Array.isArray(record.temperatures)
    ? record.temperatures as Record<string, unknown>
    : {};

  record.models = {
    gateway: typeof rawModels.gateway === 'string'
      ? normalizeModelId(rawModels.gateway)
      : legacyModelId ?? DEFAULT_MODEL_IDS.gateway,
    run: typeof rawModels.run === 'string'
      ? normalizeModelId(rawModels.run)
      : legacyModelId ?? DEFAULT_MODEL_IDS.run,
    compile: typeof rawModels.compile === 'string'
      ? normalizeModelId(rawModels.compile)
      : legacyModelId ?? DEFAULT_MODEL_IDS.compile,
  };

  record.temperatures = {
    gateway: coerceTemperature(rawTemperatures.gateway, DEFAULT_TEMPERATURES.gateway),
    run: coerceTemperature(rawTemperatures.run, DEFAULT_TEMPERATURES.run),
    compile: coerceTemperature(rawTemperatures.compile, DEFAULT_TEMPERATURES.compile),
  };

  const rawShell = record.shell && typeof record.shell === 'object' && !Array.isArray(record.shell)
    ? record.shell as Record<string, unknown>
    : {};

  record.shell = {
    wrapper: typeof rawShell.wrapper === 'string' && ['auto', 'clean-room', 'bwrap', 'sandbox-exec'].includes(rawShell.wrapper)
      ? rawShell.wrapper
      : 'auto',
    strictIsolation: typeof rawShell.strictIsolation === 'boolean'
      ? rawShell.strictIsolation
      : false,
  };

  return record;
}

function coerceTemperature(value: unknown, fallback: number): number {
  if (typeof value === 'number' && value >= 0 && value <= 2) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) {
      return parsed;
    }
  }
  return fallback;
}

function serializeConfig(config: Config): string {
  const { model, provider, ...rest } = config;
  return JSON.stringify(rest, null, 2) + '\n';
}

export function resolveCompactionConfig(
  config: Config,
  workspaceRoot: string,
): CompactionOptions | undefined {
  const compaction = config.compaction;
  if (!compaction) {
    return undefined;
  }

  const bindings = compaction.bindings?.map((binding) => ({
    ...binding,
    compactor: {
      ...binding.compactor,
      source: binding.compactor.sourceType === 'file' && !path.isAbsolute(binding.compactor.source)
        ? path.resolve(workspaceRoot, binding.compactor.source)
        : binding.compactor.source,
    },
  }));

  return {
    ...compaction,
    bindings,
  };
}

/**
 * Check if configuration exists
 */
export type ReplConfig = Config['repl'];

/**
 * Load configuration for the REPL without requiring `.deepclause/` to exist.
 *
 * The REPL is a goal-mode-capable tool that must run from a clean checkout
 * (see the plan's smoke test), so a missing config falls back to defaults
 * rather than creating the workspace directory.
 */
export async function loadReplConfig(workspaceRoot: string): Promise<Config> {
  if (await configExists(workspaceRoot)) {
    return loadConfig(workspaceRoot);
  }
  return getDefaultConfig();
}

export async function configExists(workspaceRoot: string): Promise<boolean> {
  try {
    await fs.access(getConfigPath(workspaceRoot));
    return true;
  } catch {
    return false;
  }
}

export async function deepClauseDirExists(workspaceRoot: string): Promise<boolean> {
  try {
    await fs.access(getConfigDir(workspaceRoot));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of configured MCP servers
 */
export function getMCPServers(config: Config): Record<string, MCPServer> {
  return config.mcp?.servers || {};
}
