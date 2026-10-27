import signale from 'signale';

import {redis} from '../database/redis.js';

/**
 * Plunk Lite: when a workflow was last enabled, for its brake (SourceBrakeService) to count its
 * bounces from then on, so that the ones that stopped it do not stop it again as soon as it is
 * enabled. Kept for a day, as long as the brake counts back. The workflow's `updatedAt` would not
 * do: any edit moves it.
 */
const KEY = (workflowId: string) => `plunk-lite:workflow-enabled:${workflowId}`;
const KEEP_SECONDS = 86400;

export const WorkflowEnabledAt = {
  /** Notes that the workflow was just enabled. Never throws: without it, the brake counts the whole day. */
  async note(workflowId: string): Promise<void> {
    try {
      await redis.set(KEY(workflowId), new Date().toISOString(), 'EX', KEEP_SECONDS);
    } catch (error) {
      signale.warn(`[BRAKE] Could not note that workflow ${workflowId} was enabled:`, error);
    }
  },

  /** When the workflow was last enabled, within the last day; undefined when Redis cannot say */
  async get(workflowId: string): Promise<Date | undefined> {
    try {
      const value = await redis.get(KEY(workflowId));
      const date = value ? new Date(value) : undefined;
      return date && !Number.isNaN(date.getTime()) ? date : undefined;
    } catch (error) {
      signale.warn(`[BRAKE] Could not read when workflow ${workflowId} was enabled:`, error);
      return undefined;
    }
  },
};
