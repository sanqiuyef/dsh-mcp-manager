/**
 * dsh-mcp-manager — startup diagnostics snapshot.
 *
 * A real install is where this plugin's assumptions get tested: whether
 * `@deepseek-ai/dsh-atomic-write` resolves, whether `ctx.subprocess.spawn` is the
 * shape the probe expects, how many probe results are cached, and what the list
 * route actually saw at startup. None of that is visible from the settings page, and
 * asking a user to open devtools to find out is not a diagnostic.
 *
 * So each `apply` writes one JSON snapshot under
 * `<profileDir>/data/mcp-manager/snapshot-<ISO>.json`:
 *
 *   - the complete `GET /servers` response (the same object the page receives),
 *   - plus a `backend` block of facts about this process.
 *
 * Guarantees, in order of importance:
 *   1. **No credential values.** The payload is exactly the list response, whose
 *      contract already forbids evaluated config and secret values, plus type/size
 *      facts. `scripts/smoke.mjs` asserts a literal credential planted in the raw
 *      layer never appears in the file.
 *   2. **Fire and forget.** The write is scheduled 500 ms after the routes are
 *      registered and its promise is never awaited by `apply`; a failed snapshot logs
 *      one warning and changes nothing else.
 *   3. **Bounded.** Only the newest `SNAPSHOT_KEEP` files are retained.
 *   4. **Private.** Written through the same atomic writer as the patch (mode 0600).
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteBackend, profileDirOf, writePatchText } from './patch.js';
import { probeCacheSize } from './probe.js';
import { listServers } from './servers.js';

/** Subdirectory of the profile's `data/` that holds snapshots (and backups). */
export const SNAPSHOT_DIRECTORY = 'mcp-manager';

/** How many snapshot files are kept. */
export const SNAPSHOT_KEEP = 10;

/** Delay between route registration and the snapshot, so it describes a settled host. */
export const SNAPSHOT_DELAY_MS = 500;

/** Last snapshot path written by this module instance, surfaced on `GET /servers`. */
let lastPath = null;
/** ISO timestamp of that snapshot. */
let lastAt = null;

/** The most recent snapshot path in this process, or `null`. */
export function lastSnapshotPath() {
  return lastPath;
}

/** The ISO time of the most recent snapshot, or `null`. */
export function lastSnapshotAt() {
  return lastAt;
}

/** Process facts worth recording next to the list response. */
async function backendFacts(ctx) {
  return {
    // 'used' means the host's own lock/atomic-write implementation resolved and is
    // being shared; 'fallback' means the bundled equivalent is in use.
    atomicWrite: await atomicWriteBackend(),
    // typeof, not the handle itself: the snapshot must stay JSON and value-free.
    subprocess: typeof ctx.subprocess?.spawn,
    probeCache: probeCacheSize(),
  };
}

/**
 * Write one snapshot now.
 *
 * Exported for the smoke test and for a future "capture now" diagnostic; the plugin
 * itself only calls it through `scheduleSnapshot`.
 *
 * @param {object} ctx
 * @param {{ profileDir?: string }} [options]
 * @returns {Promise<string>} the snapshot file path
 */
export async function captureSnapshot(ctx, options = {}) {
  const profileDir = typeof options.profileDir === 'string' && options.profileDir !== '' ? options.profileDir : profileDirOf(ctx);
  const view = await listServers(ctx);
  const backend = await backendFacts(ctx);
  const snapshot = { ...view, backend };

  const directory = join(profileDir, 'data', SNAPSHOT_DIRECTORY);
  await mkdir(directory, { recursive: true });

  // Two snapshots inside the same millisecond must not overwrite each other; the
  // suffix keeps the lexicographic order (and therefore pruning) correct.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let path = join(directory, `snapshot-${stamp}.json`);
  for (let suffix = 2; existsSync(path); suffix += 1) {
    path = join(directory, `snapshot-${stamp}-${suffix}.json`);
  }

  await writePatchText(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  lastPath = path;
  lastAt = new Date().toISOString();

  await pruneSnapshots(directory);
  return path;
}

/** Keep the newest `SNAPSHOT_KEEP` snapshot files; never fail the capture over it. */
async function pruneSnapshots(directory) {
  try {
    const names = (await readdir(directory))
      .filter((name) => name.startsWith('snapshot-') && name.endsWith('.json'))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - SNAPSHOT_KEEP))) {
      await rm(join(directory, name), { force: true });
    }
  } catch (error) {
    console.warn(`[dsh-mcp-manager] snapshot pruning failed: ${error?.message ?? error}`);
  }
}

/**
 * Schedule the startup snapshot and return a cancellation handle.
 *
 * `void …catch()` is the contract: `apply` must never await this, and a snapshot that
 * cannot be written must not surface as a plugin failure. `unref` keeps a 500 ms
 * timer from being the reason a short-lived process stays alive.
 *
 * @param {object} ctx
 * @param {number} [delayMs]
 * @returns {() => void} cancel
 */
export function scheduleSnapshot(ctx, delayMs = SNAPSHOT_DELAY_MS) {
  const timer = setTimeout(() => {
    void captureSnapshot(ctx).catch((error) => {
      console.warn(`[dsh-mcp-manager] startup snapshot failed: ${error?.message ?? error}`);
    });
  }, Math.max(0, delayMs));
  timer.unref?.();
  return () => clearTimeout(timer);
}
