import { existsSync } from 'fs';
import { access, readFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export type SystemPromptAssetName = 'task';
export type SystemCompactorAssetName = 'default-session-compactor' | 'default-loop-compactor';
export type WorkspaceDocAssetName = 'dml-reference' | 'dml-authoring';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COMPACTORS_DIR = join(__dirname, 'compactors');
const DOCS_DIR = join(__dirname, 'docs');
const SYSTEM_OVERRIDE_DIR = '.deepclause/system';

interface SystemAssetLookupOptions {
  workspaceRoot?: string;
  workspacePath?: string;
}

function getSystemPromptFileName(name: SystemPromptAssetName): string {
  switch (name) {
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

export function getSystemPromptAssetPath(name: SystemPromptAssetName): string {
  return join(DOCS_DIR, getSystemPromptFileName(name));
}

export function getSystemCompactorAssetPath(name: SystemCompactorAssetName): string {
  return join(COMPACTORS_DIR, getSystemCompactorFileName(name));
}

function getWorkspaceDocFileName(name: WorkspaceDocAssetName): string {
  switch (name) {
    case 'dml-reference':
      return 'DML_REFERENCE.md';
    case 'dml-authoring':
      return 'DML_AUTHORING.md';
  }
}

export function getWorkspaceDocAssetPath(name: WorkspaceDocAssetName): string {
  return join(DOCS_DIR, getWorkspaceDocFileName(name));
}

function getWorkspaceOverridePath(workspaceRoot: string, fileName: string): string {
  return join(workspaceRoot, SYSTEM_OVERRIDE_DIR, fileName);
}

function findWorkspaceOverridePathSync(
  fileName: string,
  options: SystemAssetLookupOptions = {},
): string | null {
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

export async function readSystemPromptAsset(
  name: SystemPromptAssetName,
  options: SystemAssetLookupOptions = {},
): Promise<string> {
  return readFile(await resolveSystemPromptAssetPath(name, options), 'utf8');
}
