import signale from 'signale';

import {Keys} from './keys.js';
import {errorMessage, redis, wrapRedis} from '../database/redis.js';
import {prisma} from '../database/prisma.js';

/** Plunk Lite: how long an API key that matches no project is remembered as unknown */
const UNKNOWN_KEY_SECONDS = 30;

export class ProjectService {
  public static async id(id: string) {
    return wrapRedis(Keys.Project.id(id), async () => {
      return prisma.project.findUnique({where: {id}});
    });
  }

  // Plunk Lite: an unknown key is remembered too, briefly, so repeating one costs no query
  public static async secret(key: string) {
    return wrapRedis(
      Keys.Project.secret(key),
      async () => {
        return prisma.project.findUnique({
          where: {
            secret: key,
          },
        });
      },
      undefined,
      {missSeconds: UNKNOWN_KEY_SECONDS},
    );
  }

  public static async public(key: string) {
    return wrapRedis(
      Keys.Project.public(key),
      async () => {
        return prisma.project.findUnique({
          where: {
            public: key,
          },
        });
      },
      undefined,
      {missSeconds: UNKNOWN_KEY_SECONDS},
    );
  }

  /**
   * Drops projects from the caches above, by their id and both keys, so a change to one -- being
   * disabled or reactivated, new keys, a new name -- applies to the next request rather than when
   * the cache expires. A failure is only logged: the cache then expires within a minute.
   */
  public static async invalidate(...projects: {id: string; secret: string; public: string}[]): Promise<void> {
    try {
      await redis.del(
        ...projects.flatMap(project => [
          Keys.Project.id(project.id),
          Keys.Project.secret(project.secret),
          Keys.Project.public(project.public),
        ]),
      );
    } catch (error) {
      // Only the message: a Redis error carries its command's arguments, the API keys here
      signale.warn(`[PROJECT] Could not drop the cached project: ${errorMessage(error)}`);
    }
  }
}
