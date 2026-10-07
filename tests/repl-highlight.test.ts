/**
 * Prolog listing cleanup and syntax highlighting.
 */
import { describe, expect, it } from 'vitest';

import {
  formatListing,
  highlightProlog,
  reflowListing,
  splitTopLevelGoals,
  tokenizeProlog,
} from '../src/repl/highlight.js';

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const strip = (text: string): string => text.replace(ANSI_PATTERN, '');

const LISTING = [
  'research/2',
  '  % Answer a question with task/2.',
  '  research(Question, Answer) :-',
  '      task(format("Answer ~w", [Question]), Answer), output(Answer).',
].join('\n');

describe('reflowListing', () => {
  it('merges the doc line into the header and splits long bodies', () => {
    expect(reflowListing(LISTING)).toBe([
      'research/2  % Answer a question with task/2.',
      '  research(Question, Answer) :-',
      '      task(format("Answer ~w", [Question]), Answer),',
      '      output(Answer).',
    ].join('\n'));
  });

  it('separates predicates with a blank line', () => {
    const input = [
      'a/1',
      '  % first',
      '  a(X) :-',
      '      b(X), c(X).',
      'b/1',
      '  b(1).',
    ].join('\n');
    expect(reflowListing(input)).toBe([
      'a/1  % first',
      '  a(X) :-',
      '      b(X),',
      '      c(X).',
      '',
      'b/1',
      '  b(1).',
    ].join('\n'));
  });

  it('leaves tools/history-style text alone', () => {
    const input = 'bash - [string]\n#!/bin/sh\necho hi\n';
    expect(reflowListing(input)).toBe('bash - [string]\n#!/bin/sh\necho hi');
  });
});

describe('splitTopLevelGoals', () => {
  it('only splits top-level commas', () => {
    expect(splitTopLevelGoals('      a(X), b(format("x, y", [X])), c([1, 2, 3]).')).toEqual([
      '      a(X),',
      '      b(format("x, y", [X])),',
      '      c([1, 2, 3]).',
    ]);
  });

  it('does not split a line without top-level commas', () => {
    expect(splitTopLevelGoals('      task("hello", R).')).toEqual(['      task("hello", R).']);
  });
});

describe('tokenizeProlog', () => {
  it('recognizes comments, strings, variables, numbers, functors, and cuts', () => {
    expect(tokenizeProlog('% c').map((token) => token.kind)).toContain('comment');
    expect(tokenizeProlog('"hi"')[0].kind).toBe('string');
    expect(tokenizeProlog("'quoted atom'")[0].kind).toBe('quotedAtom');
    expect(tokenizeProlog('Variable')[0].kind).toBe('variable');
    expect(tokenizeProlog('3.14')[0].kind).toBe('number');
    expect(tokenizeProlog('foo(X)')[0].kind).toBe('functor');
    expect(tokenizeProlog('!')[0].kind).toBe('cut');
  });
});

describe('highlightProlog', () => {
  it('preserves the visible text exactly', () => {
    const source = 'research(X) :- task("hi, there", X), X > 2. % note';
    expect(strip(highlightProlog(source))).toBe(source);
  });

  it('colors the pieces that help readability', () => {
    expect(highlightProlog('% comment')).toContain('\u001b[38;5;244m');
    expect(highlightProlog('"str"')).toContain('\u001b[38;5;179m');
    expect(highlightProlog('Variable')).toContain('\u001b[38;5;111m');
    expect(highlightProlog('42')).toContain('\u001b[38;5;215m');
    expect(highlightProlog('foo(X)')).toContain('\u001b[38;5;81m');
    expect(highlightProlog('!')).toContain('\u001b[1;31m');
  });

  it('is a no-op when color is disabled', () => {
    const source = 'research(X) :- task("hi", X).';
    expect(highlightProlog(source, false)).toBe(source);
  });
});

describe('formatListing', () => {
  it('highlights the header and preserves the cleaned text', () => {
    const rendered = formatListing(LISTING);
    expect(rendered).toContain('\u001b[1;36mresearch/2');
    expect(strip(rendered)).toBe(reflowListing(LISTING));
  });

  it('emits no ANSI when color is disabled', () => {
    const rendered = formatListing(LISTING, { color: false });
    expect(rendered).not.toMatch(ANSI_PATTERN);
    expect(rendered).toBe(reflowListing(LISTING));
  });
});
