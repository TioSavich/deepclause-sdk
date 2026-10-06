/**
 * Harness export helpers (M2).
 *
 * The actual serialization lives in Prolog (`export_harness/3`); this module
 * builds the header, applies the optional `--skill` wrapper, and defines the
 * result shape.
 */

export interface HarnessExportOptions {
  /** Override the header comment line (used by deterministic tests). */
  header?: string;
  /** Mark the export as a skill (header only). Define `agent_main` in the harness for `run`. */
  skill?: boolean;
  /** Output path; defaults to `harness.dml` in the workspace. */
  path?: string;
}

export interface HarnessExportResult {
  path: string;
  clauses: number;
  tools: number;
  scripts: number;
}

/** Header used when the caller does not supply one. */
export function buildHarnessHeader(info: {
  timestamp?: string;
  backend?: string;
  model?: string;
} = {}): string {
  const parts = ['DML harness — exported'];
  if (info.timestamp) parts.push(info.timestamp);
  if (info.backend) parts.push(`backend: ${info.backend}`);
  if (info.model) parts.push(`model: ${info.model}`);
  return parts.join(' ');
}

/** Strip the informational header line, e.g. for byte-stability comparisons. */
export function stripExportHeader(text: string): string {
  return text.replace(/^% DML harness[^\n]*\n/, '');
}
