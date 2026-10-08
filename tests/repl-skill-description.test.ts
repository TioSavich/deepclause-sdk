/**
 * `module_doc/1` is the harness's skill description.
 *
 * The manifest leads with `- skill: <module_doc>` so the authoring agent can read
 * it at the start of a session and re-read it whenever the harness changes, and a
 * file containing only `module_doc/1` is a valid, discoverable skill.
 */
import { describe, expect, it } from 'vitest';

import { loadProlog, type SWIPLModule } from '../src/prolog/loader.js';

let swipl: SWIPLModule | null = null;

async function getSwipl(): Promise<SWIPLModule> {
  if (!swipl) swipl = await loadProlog();
  return swipl;
}

let sessionCounter = 0;
function freshSession(prefix: string): string {
  sessionCounter += 1;
  return `${prefix}_${Date.now()}_${sessionCounter}`;
}

function plain(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const tagged = value as { $t?: string; v?: unknown };
    if (tagged.$t) return tagged.v;
  }
  return value;
}

/** Load DML into a fresh REPL session; returns the parse error (or `none`). */
function parse(module: SWIPLModule, session: string, code: string): string {
  const path = `/tmp/${session}.dml`;
  module.FS.writeFile(path, code);
  const result = module.prolog
    .query(`deepclause_mi:parse_dml('${path}', '${session}', 'mem', params{}, Error)`)
    .once() as Record<string, unknown> | null;
  return String(plain(result?.Error));
}

function manifest(module: SWIPLModule, session: string): string {
  const result = module.prolog
    .query(`deepclause_mi:repl_manifest('${session}', Text)`)
    .once() as Record<string, unknown> | null;
  return String(plain(result?.Text) ?? '');
}

function listing(module: SWIPLModule, session: string): string {
  const result = module.prolog
    .query(`deepclause_mi:repl_listing('${session}', all, Text)`)
    .once() as Record<string, unknown> | null;
  return String(plain(result?.Text) ?? '');
}

describe('module_doc as the skill description', () => {
  it('leads the manifest with the skill line', async () => {
    const module = await getSwipl();
    const session = freshSession('sess_skill');
    expect(parse(
      module,
      session,
      'module_doc("Triage harness: route messages. Use when a message needs a team.").\n',
    )).toBe('none');

    const text = manifest(module, session);
    expect(text.split('\n')[0]).toBe(
      '- skill: Triage harness: route messages. Use when a message needs a team.',
    );
  });

  it('accepts a file that is only a module doc', async () => {
    const module = await getSwipl();
    const session = freshSession('sess_skill_only');
    expect(parse(module, session, 'module_doc("A capability with no body yet.").\n')).toBe('none');

    const text = manifest(module, session);
    expect(text).toContain('- skill: A capability with no body yet.');
    expect(text).toContain('- predicates: [module_doc/1]');
  });

  it('marks a missing skill description', async () => {
    const module = await getSwipl();
    const session = freshSession('sess_no_skill');
    expect(parse(module, session, 'answer_noop.\n')).toBe('none');
    expect(manifest(module, session)).toContain('- skill: (none;');
  });

  it('shows the skill description first in listing', async () => {
    const module = await getSwipl();
    const session = freshSession('sess_listing');
    expect(parse(module, session, 'module_doc("Triage harness: route messages.").\nfoo(1).\n')).toBe('none');
    expect(listing(module, session).split('\n')[0]).toBe('skill: Triage harness: route messages.');
  });
});
