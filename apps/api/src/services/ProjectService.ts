import {Keys} from './keys.js';
import {redis, wrapRedis} from '../database/redis.js';
import {prisma} from '../database/prisma.js';

export class ProjectService {
  public static async id(id: string) {
    return wrapRedis(Keys.Project.id(id), async () => {
      return prisma.project.findUnique({where: {id}});
    });
  }

  public static async secret(key: string) {
    return wrapRedis(Keys.Project.secret(key), async () => {
      return prisma.project.findUnique({
        where: {
          secret: key,
        },
      });
    });
  }

  public static async public(key: string) {
    return wrapRedis(Keys.Project.public(key), async () => {
      return prisma.project.findUnique({
        where: {
          public: key,
        },
      });
    });
  }

  /**
   * Drops a project from the caches above, by its id and both keys, so a change to it -- being
   * reactivated (Plunk Lite) -- applies to the next request rather than when the cache expires
   */
  public static async invalidate(project: {id: string; secret: string; public: string}): Promise<void> {
    await redis.del(
      Keys.Project.id(project.id),
      Keys.Project.secret(project.secret),
      Keys.Project.public(project.public),
    );
  }
}
