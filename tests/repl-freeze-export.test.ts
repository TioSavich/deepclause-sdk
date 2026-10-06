/**
 * M2 — freeze lock + export/reload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createHarnessRepl, type HarnessRepl } from '../src/repl/index.js';
import type { DMLEvent } from '../src/types.js';

let workspace: string;
let otherWorkspace: string;
let repl: HarnessRepl;

async function openRepl(ws: string): Promise<HarnessRepl> {
  return createHarnessRepl({ workspacePath: ws, model: 'test-model', provider: 'openai' });
}

async function collect(gen: AsyncGenerator<DMLEvent>): Promise<DMLEvent[]> {
  const events: DMLEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function values(events: DMLEvent[], name: string): string[] {
  return events
    .filter((event) => event.type === 'solution')
    .map((event) => event.solution?.bindings.find((binding) => binding.name === name)?.value ?? '');
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-freeze-'));
  otherWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-other-'));
  repl = await openRepl(workspace);
});

afterEach(async () => {
  await repl.dispose();
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(otherWorkspace, { recursive: true, force: true });
});

describe('freeze lock', () => {
  it('refuses assertz, retract, consult, load, and reset while frozen', async () => {
    await repl.session.loadCode('seed(1).\n');
    await repl.freeze();
    expect(repl.isFrozen()).toBe(true);

    expect((await collect(repl.query('assertz(extra(1))'))).some((event) => event.type === 'error')).toBe(true);
    expect((await collect(repl.query('retract(seed(1))'))).some((event) => event.type === 'error')).toBe(true);
    expect((await collect(repl.query('["other.dml"]'))).some((event) => event.type === 'error')).toBe(true);
    expect((await repl.session.loadCode('more(1).\n')).error).toBeDefined();
    await expect(repl.reset()).rejects.toThrow(/frozen/);
  });

  it('keeps read-only queries working while frozen', async () => {
    await repl.session.loadCode('seed(42).\n');
    await repl.freeze();
    expect(values(await collect(repl.query('seed(X)')), 'X')).toEqual(['42']);
  });

  it('restores mutation after unfreeze', async () => {
    await repl.freeze();
    await repl.unfreeze();
    expect(repl.isFrozen()).toBe(false);
    expect((await repl.session.loadCode('extra(1).\n')).error).toBeUndefined();
    expect(values(await collect(repl.query('extra(X)')), 'X')).toEqual(['1']);
  });

  it('forbids unfreeze when locked', async () => {
    await repl.lock();
    expect(repl.isFrozen()).toBe(true);
    await expect(repl.unfreeze()).rejects.toThrow(/locked/);
  });
});

describe('export and reload', () => {
  it('is byte-stable across export -> load -> export (header normalized)', async () => {
    await repl.session.loadCode([
      ':- use_module(library(clpfd)).',
      'greet(Name, Out) :- format(string(Out), "hi ~w", [Name]).',
      'tool(greet_tool(Name, Out), "Greet someone") :- greet(Name, Out).',
      'demo :- greet("world", X), output(X).',
      '',
    ].join('\n'));

    const first = await repl.export('one.dml', { header: 'stable header' });
    const firstText = await fs.readFile(first.path, 'utf8');

    // The export lives in the original workspace; copy it into a fresh one and
    // reload so the round-trip is exercised end to end.
    await fs.copyFile(first.path, path.join(otherWorkspace, 'one.dml'));
    const reloaded = await openRepl(otherWorkspace);
    try {
      expect((await reloaded.load('one.dml')).error).toBeUndefined();
      const second = await reloaded.export('two.dml', { header: 'stable header' });
      const secondText = await fs.readFile(second.path, 'utf8');
      expect(secondText).toBe(firstText);
      expect(second.clauses).toBe(first.clauses);
      expect(second.tools).toBe(1);
      expect(second.scripts).toBe(0);

      // Prolog strings render quoted (write_term quoted(true)).
      const events = await collect(reloaded.query('greet("bob", X)'));
      expect(values(events, 'X')).toEqual(['"hi bob"']);
    } finally {
      await reloaded.dispose();
    }
  });

  it('runs the predicate identically after export -> load', async () => {
    await repl.session.loadCode([
      'demo :- fact(5, F), output(F).',
      'fact(0, 1).',
      'fact(N, F) :- N > 0, N1 is N - 1, fact(N1, F1), F is N * F1.',
      '',
    ].join('\n'));

    const before = await collect(repl.query('demo'));
    const beforeOutputs = before.filter((event) => event.type === 'output').map((event) => event.content);

    const exported = await repl.export('entry.dml', { header: 'h' });
    const reloaded = await openRepl(otherWorkspace);
    try {
      await fs.copyFile(exported.path, path.join(otherWorkspace, 'entry.dml'));
      await reloaded.load('entry.dml');
      const after = await collect(reloaded.query('demo'));
      const afterOutputs = after.filter((event) => event.type === 'output').map((event) => event.content);
      expect(afterOutputs).toEqual(beforeOutputs);
      expect(afterOutputs).toEqual(['120']);
    } finally {
      await reloaded.dispose();
    }
  });

  it('bundles linked script files and runs them after workspace cleanup', async () => {
    await fs.mkdir(path.join(workspace, '.dc-repl/scripts'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.dc-repl/scripts/writer.txt'), 'hello-from-script', 'utf8');
    await repl.session.loadCode([
      'script_file(writer, ".dc-repl/scripts/writer.txt").',
      'read_writer(Out) :- script_file(writer, Path), read_file(Path, Out).',
      'read_writer :- read_writer(Out), output(Out).',
      '',
    ].join('\n'));

    const exported = await repl.export('harness.zip', { header: 'h' });
    expect(exported.path.endsWith('.zip')).toBe(true);
    expect(exported.scripts).toBe(1);

    // Reload in a clean workspace (no .dc-repl) from the bundle alone.
    const cleanWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-clean-'));
    const reloaded = await openRepl(cleanWorkspace);
    try {
      await fs.copyFile(exported.path, path.join(cleanWorkspace, 'harness.zip'));
      expect((await reloaded.load('harness.zip')).error).toBeUndefined();
      expect(await fs.readFile(path.join(cleanWorkspace, '.dc-repl/scripts/writer.txt'), 'utf8'))
        .toBe('hello-from-script');
      const events = await collect(reloaded.query('read_writer'));
      expect(events.filter((event) => event.type === 'output').map((event) => event.content))
        .toContain('hello-from-script');
    } finally {
      await reloaded.dispose();
      await fs.rm(cleanWorkspace, { recursive: true, force: true });
    }
  });

  it('auto-inlines linked files into a single .dml and materializes them on load', async () => {
    await fs.writeFile(path.join(workspace, 'note.txt'), 'inline-me', 'utf8');
    await repl.session.loadCode([
      'script_file(note, "note.txt").',
      'read_note(Out) :- script_file(note, Path), read_file(Path, Out).',
      'read_note :- read_note(Out), output(Out).',
      '',
    ].join('\n'));

    const exported = await repl.export('harness.dml', { header: 'h' });
    const text = await fs.readFile(exported.path, 'utf8');
    expect(text).toContain('embedded_file("note.txt"');

    const cleanWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-inline-'));
    const reloaded = await openRepl(cleanWorkspace);
    try {
      await fs.copyFile(exported.path, path.join(cleanWorkspace, 'harness.dml'));
      expect((await reloaded.load('harness.dml')).error).toBeUndefined();
      expect(await fs.readFile(path.join(cleanWorkspace, 'note.txt'), 'utf8')).toBe('inline-me');
      const events = await collect(reloaded.query('read_note'));
      expect(events.filter((event) => event.type === 'output').map((event) => event.content))
        .toContain('inline-me');
    } finally {
      await reloaded.dispose();
      await fs.rm(cleanWorkspace, { recursive: true, force: true });
    }
  });

  it('export --skill marks the header and adds no wrapper (agent_main is authored)', async () => {
    await repl.session.loadCode('agent_main :- output("ok").\n');
    const exported = await repl.export('skill.dml', { skill: true });
    const text = await fs.readFile(exported.path, 'utf8');
    expect(text).toContain('backend: skill');
    expect(text).toContain('agent_main :-');
  });

  it('removes a predicate via the repl_delete/1 directive', async () => {
    await repl.session.loadCode('temp(1).\nkeep(2).\n');
    expect((await repl.session.loadCode('repl_delete(temp/1).\n')).error).toBeUndefined();

    const removed = await collect(repl.query('temp(X)'));
    expect(removed.some((event) => event.type === 'solution')).toBe(false);

    expect(values(await collect(repl.query('keep(X)')), 'X')).toEqual(['2']);
  });
});
