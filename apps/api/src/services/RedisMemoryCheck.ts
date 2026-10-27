import signale from 'signale';

import {redis} from '../database/redis.js';
import {FailureAlertService} from './FailureAlertService.js';

/** Share of maxmemory at which the projects are warned, and below which the warning is cleared */
const WARN_RATIO = 0.8;
const CLEAR_RATIO = 0.7;
const SOURCE_KEY = 'redis:memory';

const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * Plunk Lite: how full Redis is, against the maxmemory the compose gives it. With noeviction, the
 * policy BullMQ needs, a full Redis refuses every write: emails stop being queued and the API
 * answers 500. Shown in every project, disabled ones included, since it is the installation's.
 * Without a maxmemory there is nothing to compare against, and nothing is said.
 */
export async function checkRedisMemory(): Promise<void> {
  const info = await redis.info('memory');
  const used = Number(/^used_memory:(\d+)/m.exec(info)?.[1] ?? 0);
  const max = Number(/^maxmemory:(\d+)/m.exec(info)?.[1] ?? 0);
  if (!max) {
    return;
  }

  const ratio = used / max;
  if (ratio >= WARN_RATIO) {
    signale.warn(`[REDIS] Using ${megabytes(used)} MB of its ${megabytes(max)} MB`);
    await FailureAlertService.recordForAll(
      {
        sourceKey: SOURCE_KEY,
        label: 'Redis is running out of memory',
        error: `Redis uses ${megabytes(used)} MB of its ${megabytes(max)} MB. Once full it refuses every write: emails stop being queued and the API answers 500. Raise REDIS_MAXMEMORY in the compose, or find what fills it.`,
      },
      {includeDisabled: true},
    );
  } else if (ratio < CLEAR_RATIO) {
    await FailureAlertService.resolve(SOURCE_KEY);
  }
}
