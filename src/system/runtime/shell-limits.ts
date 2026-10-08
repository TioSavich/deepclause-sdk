/**
 * Shell execution limits.
 *
 * Two independent timers bound a command:
 *
 * - **idle** — kill a command that produces no output for `idleMs`
 *   (`DC_HOST_SHELL_IDLE_TIMEOUT_MS`, default 180 000 ms). This is what stops a
 *   command that has hung.
 * - **wall** — kill a command that runs longer than `timeoutMs` regardless of
 *   output (`DC_HOST_SHELL_TIMEOUT_MS`, default 0 = disabled). A per-command
 *   `timeoutMs` (e.g. `exec(bash(command: Cmd, timeoutMs: N), R)`) overrides it.
 *
 * Both apply to the host shell and the AgentVM sandbox.
 */

const DEFAULT_HOST_SHELL_IDLE_TIMEOUT_MS = 180_000;
const DEFAULT_HOST_SHELL_TIMEOUT_MS = 0;

function readNonNegativeMs(name: string): number | null {
  const raw = process.env[name];
  if (raw == null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Idle timeout (no output) for a shell command, in ms; 0 disables it. */
export function getHostShellIdleTimeoutMs(): number {
  return readNonNegativeMs('DC_HOST_SHELL_IDLE_TIMEOUT_MS') ?? DEFAULT_HOST_SHELL_IDLE_TIMEOUT_MS;
}

/** Wall-clock timeout for a shell command, in ms; 0 disables it. */
export function getHostShellTimeoutMs(): number {
  return readNonNegativeMs('DC_HOST_SHELL_TIMEOUT_MS') ?? DEFAULT_HOST_SHELL_TIMEOUT_MS;
}

/** Resolve a per-command timeout: explicit value wins, else the configured default. */
export function resolveShellTimeoutMs(requested?: number): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 0) {
    return requested;
  }
  return getHostShellTimeoutMs();
}
