/**
 * Tool management utilities.
 */

import type { ToolPolicy } from './types.js';

/**
 * Check if a tool is allowed by the current policy.
 */
export function checkToolPolicy(
  toolName: string,
  policy: ToolPolicy | null,
): { allowed: boolean; reason?: string } {
  // ask_user is the human-in-the-loop channel, not a capability. It only
  // relays a question and is exempt from the capability whitelist/blacklist.
  if (toolName === 'ask_user') {
    return { allowed: true };
  }

  if (!policy) {
    return { allowed: true };
  }

  const matches = policy.tools.some((pattern) => matchToolPattern(pattern, toolName));

  if (policy.mode === 'whitelist') {
    if (matches) {
      return { allowed: true };
    }
    return { allowed: false, reason: `Tool '${toolName}' is not in the whitelist` };
  }

  if (matches) {
    return { allowed: false, reason: `Tool '${toolName}' is blocked by blacklist` };
  }
  return { allowed: true };
}

/** Match a tool name against a pattern (supports `*` wildcards). */
function matchToolPattern(pattern: string, toolName: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${regexPattern}$`).test(toolName);
}
