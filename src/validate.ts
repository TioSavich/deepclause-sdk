/**
 * DML validation and linting.
 *
 * Parses DML with the real Prolog reader and applies structural/lint checks.
 * This is the surviving part of the old compiler module (the Markdown->DML
 * generator was removed); it is exported as `deepclause-sdk/validate` and used
 * by the CLI's `validate_dml` runtime tool and by downstream apps
 * (`deepclause-pi`, `sop2harness`).
 */

import { loadProlog, type SWIPLModule } from './prolog/loader.js';

// =============================================================================
// Internal Types
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

// =============================================================================
// Prolog Validation
// =============================================================================

let prologInstance: SWIPLModule | null = null;

/**
 * Get or initialize Prolog instance for validation
 */
async function getProlog(): Promise<SWIPLModule> {
  if (!prologInstance) {
    prologInstance = await loadProlog();
  }
  return prologInstance;
}

/**
 * Validate DML code using the actual Prolog parser
 */
export async function validateWithProlog(dml: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const swipl = await getProlog();
    
    // Write code to temp file
    const tempPath = `/tmp/validate_${Date.now()}_${Math.random().toString(36).substring(7)}.pl`;
    swipl.FS.writeFile(tempPath, dml);

    // Try to parse the file using read_term which will catch syntax errors
    try {
      swipl.prolog.query(
        `catch(
          (
            open('${tempPath}', read, Stream, []),
            call_cleanup(
              read_all_terms(Stream),
              close(Stream)
            )
          ),
          Error,
          (
            Error = error(syntax_error(Message), _) -> 
              true 
            ; 
              (term_to_atom(Error, Message), true)
          )
        ), 
        read_all_terms(S) :- 
          repeat,
          read_term(S, T, [syntax_errors(error)]),
          (T == end_of_file -> ! ; fail)`
      );
      
      // Simple approach: try to consult the file
      try {
        swipl.prolog.call(`consult('${tempPath}')`);
      } catch (consultError) {
        const errMsg = consultError instanceof Error ? consultError.message : String(consultError);
        if (errMsg.includes('syntax') || errMsg.includes('error')) {
          // Extract meaningful error message
          const match = errMsg.match(/(?:syntax_error|error)\s*\(\s*['"]?([^'")\]]+)/i);
          if (match) {
            errors.push(`Syntax error: ${match[1]}`);
          } else {
            errors.push(`Parse error: ${errMsg.substring(0, 200)}`);
          }
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes('syntax') || errMsg.includes('error')) {
        errors.push(errMsg.substring(0, 200));
      }
    }

    // Check for required elements
    if (!dml.includes('agent_main')) {
      errors.push('Missing agent_main predicate - every DML program must define agent_main');
    }

    // Check for balanced delimiters
    const delimiterCheck = checkBalancedDelimiters(dml);
    errors.push(...delimiterCheck.errors);

    // Check for common mistakes
    const lintResult = lintDML(dml);
    errors.push(...lintResult.errors);
    warnings.push(...lintResult.warnings);

    // Cleanup temp file
    try {
      swipl.FS.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }

  } catch (error) {
    // If Prolog itself fails, fall back to basic validation
    return validateDMLSyntaxBasic(dml);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/**
 * Check balanced delimiters
 */
function checkBalancedDelimiters(dml: string): { errors: string[] } {
  const errors: string[] = [];
  
  // Remove strings and comments for delimiter checking
  const stripped = dml
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // Remove string contents
    .replace(/%.*$/gm, '')                 // Remove line comments
    .replace(/\/\*[\s\S]*?\*\//g, '');     // Remove block comments

  let parenCount = 0;
  let bracketCount = 0;
  let braceCount = 0;

  for (const char of stripped) {
    if (char === '(') parenCount++;
    if (char === ')') parenCount--;
    if (char === '[') bracketCount++;
    if (char === ']') bracketCount--;
    if (char === '{') braceCount++;
    if (char === '}') braceCount--;

    if (parenCount < 0) {
      errors.push('Unbalanced parentheses: extra closing )');
      break;
    }
    if (bracketCount < 0) {
      errors.push('Unbalanced brackets: extra closing ]');
      break;
    }
    if (braceCount < 0) {
      errors.push('Unbalanced braces: extra closing }');
      break;
    }
  }

  if (parenCount > 0) errors.push(`Unbalanced parentheses: ${parenCount} unclosed (`);
  if (bracketCount > 0) errors.push(`Unbalanced brackets: ${bracketCount} unclosed [`);
  if (braceCount > 0) errors.push(`Unbalanced braces: ${braceCount} unclosed {`);

  return { errors };
}

/**
 * Extract all string literals from DML code (both single and double quoted)
 */
function extractStringLiterals(dml: string): { doubleQuoted: string[]; singleQuoted: string[] } {
  const doubleQuoted: string[] = [];
  const singleQuoted: string[] = [];
  // Double-quoted strings
  for (const m of dml.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    doubleQuoted.push(m[1]);
  }
  // Single-quoted atoms
  for (const m of dml.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
    singleQuoted.push(m[1]);
  }
  return { doubleQuoted, singleQuoted };
}

/**
 * Strip comments and string contents for structural analysis
 */
function stripForAnalysis(dml: string): string {
  return dml
    .replace(/%.*$/gm, '')                 // line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')   // double-quoted string contents
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");  // single-quoted atom contents
}

/**
 * Lint DML for common issues — focused on string handling and structural errors.
 * Returns errors (will crash at runtime) and warnings (likely wrong).
 */
function lintDML(dml: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const stripped = stripForAnalysis(dml);
  const { doubleQuoted, singleQuoted } = extractStringLiterals(dml);
  const allStrings = [...doubleQuoted, ...singleQuoted];

  // ═══════════════════════════════════════════════════════════════════════════
  // STRING HANDLING ERRORS — these WILL crash or produce wrong output
  // ═══════════════════════════════════════════════════════════════════════════

  // E1: format() passed directly to output() or answer()
  //     format/3 binds its first arg, it does NOT return a value.
  //     output(format("...", [...])) is always wrong.
  if (/output\s*\(\s*format\s*\(/.test(dml)) {
    errors.push('ERROR: format/3 does not return a value. `output(format(...))` will crash. Fix: format(string(S), "...", [...]), output(S).');
  }
  if (/answer\s*\(\s*format\s*\(/.test(dml)) {
    errors.push('ERROR: format/3 does not return a value. `answer(format(...))` will crash. Fix: format(string(S), "...", [...]), answer(S).');
  }

  // E2: ~Variable in task/prompt description strings (only ~w, ~d, ~a, ~s work with format)
  //     task("Analyze ~Topic", R) does NOT interpolate. Use {Topic}.
  for (const s of doubleQuoted) {
    if (/~[A-Z][a-zA-Z0-9_]*/.test(s)) {
      errors.push(`ERROR: ~Variable interpolation does not work in DML. Found in: "...${s.substring(0, 60)}...". Use {Variable} syntax instead (e.g. {Topic} not ~Topic).`);
      break;
    }
  }

  // E3: {Variable} inside format/3 template string
  //     format(string(S), "Hello {Name}", []) — the {Name} won't be interpolated by format.
  //     This is a style-mixing bug.
  const formatCalls = dml.matchAll(/format\s*\(\s*(?:string|atom)\s*\([^)]*\)\s*,\s*"([^"]*)"/g);
  for (const m of formatCalls) {
    const tmpl = m[1];
    if (/\{[A-Z][a-zA-Z0-9_]*\}/.test(tmpl)) {
      errors.push(`ERROR: {Variable} inside format() template does nothing — format uses ~w placeholders. Found: "${tmpl.substring(0, 60)}". Use EITHER {Variable} in task() strings OR ~w in format() strings, never both in the same string.`);
      break;
    }
  }

  // E4: String concatenation with + operator
  //     "hello" + "world" or Var + Var — Prolog's + is arithmetic only.
  if (/"\s*\+\s*"/.test(dml) || /"\s*\+\s*[A-Z]/.test(dml) || /[A-Z][a-zA-Z_0-9]*\s*\+\s*"/.test(dml)) {
    errors.push('ERROR: The + operator is arithmetic only in Prolog, not string concatenation. Use {Variable} interpolation in task() strings, or atom_concat/3, or format/3 for building strings.');
  }

  // E5: task() with non-string first arg — task(llm(...)) or task(prompt(...))
  if (/task\s*\(\s*(?:llm|prompt)\s*\(/.test(stripped)) {
    errors.push('ERROR: task() takes a plain string as first argument. task(llm(...)) and task(prompt(...)) are wrong. Use: task("description string", Var).');
  }

  // E6: Hallucinated predicates — these do NOT exist in DML runtime
  //     But skip if user defines the predicate themselves (pred(...) :- ...).
  const hallucinated: Array<[string, string]> = [
    ['json_parse', 'json_parse/2 does not exist. Use task() to extract data from JSON via LLM.'],
    ['http_get', 'http_get does not exist. Use exec(url_fetch(url: URL), R).'],
    ['string_format', 'string_format does not exist. Use format(string(R), FormatStr, Args).'],
    ['get_field', 'get_field does not exist. Use get_dict(Key, Dict, Value) — note: Key comes first.'],
    ['string_join', 'string_join does not exist. Use atomic_list_concat(List, Sep, Atom).'],
    ['string_lower', 'string_lower does not exist. Use downcase_atom(Atom, Lower).'],
    ['string_trim', 'string_trim does not exist. Use normalize_space(string(Out), In).'],
    ['contains', 'contains/2 does not exist. Use sub_atom/5 or sub_string/5.'],
  ];
  for (const [name, msg] of hallucinated) {
    const usePattern = new RegExp(`(?<!\\w)${name}\\s*\\(`, 'g');
    if (usePattern.test(stripped)) {
      // Check if user defines this predicate (name(...) :- or name(...) .)
      const defPattern = new RegExp(`^${name}\\s*\\([^)]*\\)\\s*(?::-|\\.)`, 'm');
      if (!defPattern.test(stripped)) {
        errors.push(`ERROR: ${msg}`);
      }
    }
  }

  // E7: url_fetch used as a bare predicate (not wrapped in exec)
  //     url_fetch("url", R) is wrong. Must be exec(url_fetch(url: "..."), R).
  if (/(?<!exec\s*\(\s*)url_fetch\s*\(\s*"/.test(stripped)) {
    errors.push('ERROR: url_fetch is not a predicate. Must use exec/2 wrapper: exec(url_fetch(url: URL), R).');
  }

  // E8: curl/wget in bash command strings
  for (const s of allStrings) {
    if (/\b(?:curl|wget)\s/.test(s)) {
      errors.push('ERROR: curl and wget are banned — the VM has no direct internet. Use exec(url_fetch(url: URL), R) to fetch web content.');
      break;
    }
  }

  // E9: writeln() used for user output — not a DML predicate
  if (/(?<!\w)writeln\s*\(/.test(stripped)) {
    // Check it's not inside an open/close file I/O block (write to stream is OK)
    // Simple heuristic: if there's no open() call, writeln is definitely wrong
    if (!/\bopen\s*\(/.test(stripped) || /writeln\s*\(\s*['"]/.test(dml)) {
      errors.push('ERROR: writeln() is not a DML output predicate. Use output() for progress messages and answer() for final results.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRING HANDLING WARNINGS — likely wrong, should fix
  // ═══════════════════════════════════════════════════════════════════════════

  // W1: Mixing {Variable} interpolation and format/3 in the same clause
  //     Not always wrong (different strings), but a code smell with small models
  const hasInterpolation = /\{[A-Z][a-zA-Z0-9_]*\}/.test(dml);
  const hasFormat = /format\s*\(/.test(stripped);
  if (hasInterpolation && hasFormat) {
    warnings.push('WARNING: Code mixes {Variable} interpolation and format/3. This is allowed but can confuse the runtime if mixed in the same string. Ensure {Variable} is only in task()/output()/answer() strings and ~w is only in format() strings.');
  }

  // W2: No tool definitions — model probably wrote pure Prolog
  if (!/\btool\s*\(/.test(dml)) {
    warnings.push('WARNING: No tool() definitions found. This is fine for pure Prolog or direct exec()-only skills, but LLM-driven skills usually need tool()/3 wrappers for task() calls.');
  }

  // W3: No task() call — model probably wrote pure Prolog logic
  if (!/\btask\s*\(/.test(stripped)) {
    warnings.push('WARNING: No task() call found. This is fine for deterministic or simple skills. Skills that need open-ended reasoning, summarization, extraction, or classification should usually use task().');
  }

  // W4: No system() call — LLM has no instructions
  if (!/\bsystem\s*\(/.test(stripped)) {
    warnings.push('WARNING: No system() call found. Add system() when the skill uses task()/prompt() and the LLM needs instructions on how to use tools.');
  }

  // W5: No answer() call — skill completes silently
  if (!/\banswer\s*\(/.test(stripped)) {
    warnings.push('WARNING: No answer() call found. The skill will complete without returning a result to the user.');
  }

  // W6: No output() before task/exec — skill appears frozen
  if (/\btask\s*\(/.test(stripped) && !/\boutput\s*\(/.test(stripped)) {
    warnings.push('WARNING: No output() calls found. Add output() before long-running task() or exec() calls so the skill doesn\'t appear frozen.');
  }

  // W7: Single agent_main clause — no fallback
  const mainMatches = stripped.match(/agent_main\s*[\(\.]/g);
  if (mainMatches && mainMatches.length === 1) {
    warnings.push('WARNING: Only one agent_main clause. Add a fallback clause with a static error message (no LLM calls) as required by Rule 7.');
  }

  // W8: Dict dot notation — Result.field etc.
  //     Only check outside strings — match Var.key pattern in code
  if (/[A-Z][a-zA-Z_0-9]*\.[a-z][a-z_]+(?!\s*\()/.test(stripped)) {
    warnings.push('WARNING: Possible dict dot notation (e.g. Result.stdout). This may not work — use get_dict(Key, Dict, Value) instead.');
  }

  return { errors, warnings };
}

/**
 * Basic syntax validation (fallback when Prolog fails)
 */
function validateDMLSyntaxBasic(dml: string): ValidationResult {
  const errors: string[] = [];

  if (!dml.includes('agent_main')) {
    errors.push('Missing agent_main predicate');
  }

  const delimiterCheck = checkBalancedDelimiters(dml);
  errors.push(...delimiterCheck.errors);

  // Check for unclosed strings
  const stringPattern = /"(?:[^"\\]|\\.)*"/g;
  const cleanedDml = dml.replace(stringPattern, '""');
  if ((cleanedDml.match(/"/g) || []).length % 2 !== 0) {
    errors.push('Unclosed string literal');
  }

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)]
  };
}
