/**
 * Media references → resolved bytes.
 *
 * Media are workspace files. DML and conversation memory carry only
 * `media(Path, Mime)`; the host resolves them to base64 when a model call needs
 * the bytes. See `docs/DML_MEDIA.md`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import type { LLMBackendMedia, MediaRef } from '../../types.js';

/** Mime types DML may reference (and that pi accepts as image input). */
export const MEDIA_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Mime for a media path, or undefined when the extension is not allowed. */
export function mimeForMediaPath(file: string): string | undefined {
  return MEDIA_MIME_BY_EXT[path.extname(file).toLowerCase()];
}

/** Resolve a workspace-relative media path, rejecting traversal/absolute paths. */
export function resolveMediaPath(workspacePath: string, relPath: string): string {
  const workspace = path.resolve(workspacePath);
  if (path.isAbsolute(relPath)) {
    throw new Error(`media path must be workspace-relative: ${relPath}`);
  }
  const abs = path.resolve(workspace, relPath);
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`media path escapes the workspace: ${relPath}`);
  }
  return abs;
}

export interface ReadMediaOptions {
  maxBytes?: number;
}

/** Read one media reference into base64, enforcing the size cap. */
export async function resolveMediaRef(
  workspacePath: string,
  ref: MediaRef,
  options: ReadMediaOptions = {},
): Promise<LLMBackendMedia> {
  const maxBytes = options.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  const abs = resolveMediaPath(workspacePath, ref.path);
  const data = await fs.readFile(abs);
  if (data.byteLength > maxBytes) {
    throw new Error(`media exceeds ${maxBytes} bytes: ${ref.path}`);
  }
  return { mimeType: ref.mimeType, data: data.toString('base64') };
}

/** Read a list of media references (missing entries resolve to nothing). */
export async function resolveMediaRefs(
  workspacePath: string,
  refs: MediaRef[] | undefined,
  options: ReadMediaOptions = {},
): Promise<LLMBackendMedia[]> {
  if (!refs || refs.length === 0) return [];
  const out: LLMBackendMedia[] = [];
  for (const ref of refs) {
    out.push(await resolveMediaRef(workspacePath, ref, options));
  }
  return out;
}
