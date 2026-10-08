/**
 * Workspace project context: a `AGENTS.md` in the working directory is appended
 * to the authoring agent's system prompt, so repo-specific rules travel with the
 * session (the same idea as pi's project context files).
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

export interface ProjectContext {
  /** Absolute path to the file. */
  path: string;
  /** File content (trimmed). */
  content: string;
  /** Byte length of the trimmed content. */
  bytes: number;
}

/** Read `<workspace>/AGENTS.md` if it exists and is non-empty. */
export async function loadProjectContext(workspacePath: string | undefined): Promise<ProjectContext | null> {
  if (!workspacePath) return null;
  const file = join(workspacePath, 'AGENTS.md');
  try {
    const content = (await readFile(file, 'utf8')).trim();
    if (!content) return null;
    return { path: file, content, bytes: Buffer.byteLength(content, 'utf8') };
  } catch {
    return null;
  }
}
