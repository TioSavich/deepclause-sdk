/**
 * Helpers shared by the REPL session/frame layers.
 *
 * The frame stack itself lives in the Prolog runtime (`session_frame/4`,
 * `step_frame/4`) and is driven by `DMLRunner.runFrame`. These helpers cover
 * the Prolog-term marshalling and small presentation utilities the REPL needs.
 */

import type { FrameKind } from '../types.js';

/** Unwrap a swipl-wasm tagged value (`{ $t, v }`) into a plain JS value. */
export function plainValue(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const tagged = value as { $t?: string; v?: unknown };
    if (tagged.$t) {
      return tagged.v;
    }
  }
  return value;
}

/** Convert a JS value into a Prolog term string, mirroring DMLRunner.toPrologTerm. */
export function toPrologTerm(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => toPrologTerm(item)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${quoteAtom(key)}: ${toPrologTerm(item)}`)
      .join(', ');
    return `dict{${entries}}`;
  }
  return 'null';
}

/** Quote a string as a single-line Prolog string literal. */
export function quotePrologString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** Quote a string as a Prolog atom when needed. */
export function quoteAtom(value: string): string {
  if (/^[a-z][a-zA-Z0-9_]*$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build a `params{...}` dict term from a JS record (keys lowercased). */
export function buildParamsTerm(params: Record<string, unknown>): string {
  const entries = Object.entries(params)
    .map(([key, value]) => `${key.toLowerCase()}: ${toPrologTerm(value)}`)
    .join(', ');
  return `params{${entries}}`;
}

/** Human label for a frame kind, used by the renderer. */
export function frameKindLabel(kind: FrameKind): string {
  switch (kind) {
    case 'object':
      return 'run';
    case 'nested':
      return 'nested';
    case 'query':
    default:
      return 'query';
  }
}
