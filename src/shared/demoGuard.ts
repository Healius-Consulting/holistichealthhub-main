/**
 * Demo mode must never reach the server. While it is on, every write to the real API is a bug:
 * demo changes belong in the local demo store (src/training/demoMode.ts), so the API client
 * throws instead of sending. Reads stay allowed.
 *
 * Signing in, keeping the session alive and signing out are not demo data, so /v1/auth/ is exempt:
 * without it the session would lock mid-demo and Sign out would fail.
 */
let demoWritesBlocked = false;

export class DemoModeWriteError extends Error {
  constructor(method: string, path: string) {
    super(`Demo mode blocked a ${method} to ${path}. Nothing in demo mode is sent to the server.`);
    this.name = 'DemoModeWriteError';
  }
}

export function setDemoNetworkGuard(blocked: boolean) {
  demoWritesBlocked = blocked;
}

export function demoNetworkGuardActive() {
  return demoWritesBlocked;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function assertNotDemoWrite(method: string, path: string) {
  if (!demoWritesBlocked) return;
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb)) return;
  if (path.startsWith('/v1/auth/')) return;
  throw new DemoModeWriteError(verb, path);
}
