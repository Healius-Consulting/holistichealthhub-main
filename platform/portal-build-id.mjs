import { execFileSync } from 'node:child_process';

/**
 * The identifier stamped into the portal bundle and shown in Display settings.
 *
 * Support asks staff "which version are you on?" and needs an answer that maps
 * to a commit. It is resolved at build time, in the order of how much we trust
 * the source: an explicitly supplied id, then the deploy platform's commit, then
 * the local checkout, and finally a marker that says plainly this was not a
 * release build rather than inventing a version number.
 */
export function resolvePortalBuildId(environment = process.env) {
  const explicit = environment.PORTAL_BUILD_ID?.trim();
  if (explicit) return explicit.slice(0, 40);

  const deployed = environment.VERCEL_GIT_COMMIT_SHA?.trim();
  if (deployed) return deployed.slice(0, 12);

  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'local-build';
  }
}
