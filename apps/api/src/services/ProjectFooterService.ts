import {type ProjectFooters, toProjectFooters} from '@plunk/shared';
import {toPrismaJson} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';

// Every marketing email reads its project's footers, so each process keeps them for a minute: one
// read per project and minute however large the campaign, and a saved change reaches emails within
// a minute. Projects without footers of their own are remembered too.
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
const remembered = new Map<string, {footers: ProjectFooters; until: number}>();

/** A project's own unsubscribe footers, by language (Plunk Lite). */
export class ProjectFooterService {
  /** The project's footers, read through the same checks as a request; {} if it has none. */
  public static async get(projectId: string): Promise<ProjectFooters> {
    const hit = remembered.get(projectId);
    if (hit && hit.until > Date.now()) {
      return hit.footers;
    }

    let row;
    try {
      row = await prisma.plunkLiteProjectFooters.findUnique({where: {projectId}});
    } catch (error) {
      // The last footers read, however old, beat none: only a project never read fails the email
      if (hit) {
        signale.warn(`[FOOTERS] Failed to read the footers of project ${projectId}, using the last read:`, error);
        return hit.footers;
      }
      throw error;
    }
    const {footers} = toProjectFooters(row?.footers);
    this.remember(projectId, footers);
    return footers;
  }

  /**
   * The footers a marketing email is sent with; none for other emails, which carry no footer. A
   * failed read with nothing read before throws: the worker reads them before marking the email,
   * so the job is retried rather than the email sent without the project's footer.
   */
  public static async forEmail(emailClass: string, projectId: string): Promise<ProjectFooters | undefined> {
    return emailClass === 'marketing' ? this.get(projectId) : undefined;
  }

  /** Replaces the project's footers with `footers`, already checked. */
  public static async save(projectId: string, footers: ProjectFooters): Promise<ProjectFooters> {
    await prisma.plunkLiteProjectFooters.upsert({
      where: {projectId},
      create: {projectId, footers: toPrismaJson(footers)},
      update: {footers: toPrismaJson(footers)},
    });
    this.remember(projectId, footers);
    return footers;
  }

  /** Test seam: forget what was remembered. */
  public static clearCache(): void {
    remembered.clear();
  }

  private static remember(projectId: string, footers: ProjectFooters): void {
    if (remembered.size >= MAX_ENTRIES) {
      remembered.clear();
    }
    remembered.set(projectId, {footers, until: Date.now() + TTL_MS});
  }
}
