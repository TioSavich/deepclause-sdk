import { existsSync } from 'fs';
import { access, readFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export type SystemSkillAssetName = 'conductor' | 'skill-creator' | 'plan' | 'deep-planner' | 'security-planner';
export type SystemPromptAssetName = 'conductor' | 'skill-creator' | 'task';
export type SystemCompactorAssetName = 'default-session-compactor' | 'default-loop-compactor';
export type WorkspaceDocAssetName = 'tui' | 'dml-reference' | 'dml-authoring';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = join(__dirname, 'skills');
const COMPACTORS_DIR = join(__dirname, 'compactors');
const DOCS_DIR = join(__dirname, 'docs');
const RECIPES_DIR = join(__dirname, 'recipes');
const SYSTEM_OVERRIDE_DIR = '.deepclause/system';

interface SystemAssetLookupOptions {
  workspaceRoot?: string;
  workspacePath?: string;
}

function getSystemSkillFileName(name: SystemSkillAssetName): string {
  switch (name) {
    case 'conductor':
      return 'conductor.dml';
    case 'skill-creator':
      return 'skill-creator.dml';
    case 'plan':
      return 'plan.dml';
    case 'deep-planner':
      return 'deep-planner.dml';
    case 'security-planner':
      return 'security-planner.dml';
  }
}

function getSystemPromptFileName(name: SystemPromptAssetName): string {
  switch (name) {
    case 'conductor':
      return 'CONDUCTOR_PROMPT.md';
    case 'skill-creator':
      return 'DML_COMPILER_PROMPT.md';
    case 'task':
      return 'TASK_PROMPT.md';
  }
}

function getSystemCompactorFileName(name: SystemCompactorAssetName): string {
  switch (name) {
    case 'default-session-compactor':
      return 'default-session-compactor.dml';
    case 'default-loop-compactor':
      return 'default-loop-compactor.dml';
  }
}

export function getSystemSkillAssetPath(name: SystemSkillAssetName): string {
  return join(SKILLS_DIR, getSystemSkillFileName(name));
}

export function getSystemPromptAssetPath(name: SystemPromptAssetName): string {
  return join(DOCS_DIR, getSystemPromptFileName(name));
}

export function getSystemCompactorAssetPath(name: SystemCompactorAssetName): string {
  return join(COMPACTORS_DIR, getSystemCompactorFileName(name));
}

function getWorkspaceDocFileName(name: WorkspaceDocAssetName): string {
  switch (name) {
    case 'tui':
      return 'TUI.md';
    case 'dml-reference':
      return 'DML_REFERENCE.md';
    case 'dml-authoring':
      return 'DML_AUTHORING.md';
  }
}

export function getWorkspaceDocAssetPath(name: WorkspaceDocAssetName): string {
  return join(DOCS_DIR, getWorkspaceDocFileName(name));
}

export function getPackagedRecipeAssetsDir(): string {
  return RECIPES_DIR;
}

export function getWorkspaceRecipeAssetsDir(workspaceRoot: string): string {
  return join(workspaceRoot, SYSTEM_OVERRIDE_DIR, 'recipes');
}

function getWorkspaceOverridePath(workspaceRoot: string, fileName: string): string {
  return join(workspaceRoot, SYSTEM_OVERRIDE_DIR, fileName);
}

function findWorkspaceOverridePathSync(fileName: string, options: SystemAssetLookupOptions = {}): string | null {
  if (options.workspaceRoot) {
    const overridePath = getWorkspaceOverridePath(options.workspaceRoot, fileName);
    return existsSync(overridePath) ? overridePath : null;
  }

  if (options.workspacePath) {
    let current = resolve(options.workspacePath);

    while (true) {
      const overridePath = join(current, SYSTEM_OVERRIDE_DIR, fileName);
      if (existsSync(overridePath)) {
        return overridePath;
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return null;
}

async function resolveSystemSkillAssetPath(
  name: SystemSkillAssetName,
  options: SystemAssetLookupOptions = {},
): Promise<string> {
  const overridePath = findWorkspaceOverridePathSync(getSystemSkillFileName(name), options);
  if (overridePath) {
    try {
      await access(overridePath);
      return overridePath;
    } catch {
      // Fall back to the packaged asset when no workspace override exists.
    }
  }

  return getSystemSkillAssetPath(name);
}

async function resolveSystemPromptAssetPath(
  name: SystemPromptAssetName,
  options: SystemAssetLookupOptions = {},
): Promise<string> {
  const overridePath = findWorkspaceOverridePathSync(getSystemPromptFileName(name), options);
  if (overridePath) {
    try {
      await access(overridePath);
      return overridePath;
    } catch {
      // Fall back to the packaged asset when no workspace override exists.
    }
  }

  return getSystemPromptAssetPath(name);
}

function resolveSystemSkillAssetPathSync(
  name: SystemSkillAssetName,
  workspaceRoot?: string,
): string {
  if (workspaceRoot) {
    const overridePath = getWorkspaceOverridePath(workspaceRoot, getSystemSkillFileName(name));
    if (existsSync(overridePath)) {
      return overridePath;
    }
  }

  return getSystemSkillAssetPath(name);
}

function resolveSystemPromptAssetPathSync(
  name: SystemPromptAssetName,
  workspaceRoot?: string,
): string {
  if (workspaceRoot) {
    const overridePath = getWorkspaceOverridePath(workspaceRoot, getSystemPromptFileName(name));
    if (existsSync(overridePath)) {
      return overridePath;
    }
  }

  return getSystemPromptAssetPath(name);
}

export function getSystemAssetSourcePaths(workspaceRoot?: string): {
  conductorDml: string;
  conductorPrompt: string;
  planDml: string;
  skillCreatorDml: string;
  skillCreatorPrompt: string;
  taskPrompt: string;
} {
  return {
    conductorDml: resolveSystemSkillAssetPathSync('conductor', workspaceRoot),
    conductorPrompt: resolveSystemPromptAssetPathSync('conductor', workspaceRoot),
    planDml: resolveSystemSkillAssetPathSync('plan', workspaceRoot),
    skillCreatorDml: resolveSystemSkillAssetPathSync('skill-creator', workspaceRoot),
    skillCreatorPrompt: resolveSystemPromptAssetPathSync('skill-creator', workspaceRoot),
    taskPrompt: resolveSystemPromptAssetPathSync('task', workspaceRoot),
  };
}

export async function readSystemSkillAsset(
  name: SystemSkillAssetName,
  options: SystemAssetLookupOptions = {},
): Promise<string> {
  return readFile(await resolveSystemSkillAssetPath(name, options), 'utf8');
}

export async function readSystemPromptAsset(
  name: SystemPromptAssetName,
  options: SystemAssetLookupOptions = {},
): Promise<string> {
  return readFile(await resolveSystemPromptAssetPath(name, options), 'utf8');
}