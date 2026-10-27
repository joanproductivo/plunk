import type {Job} from 'bullmq';
import {describe, expect, it} from 'vitest';

import {createMockJob, getPrismaClient} from '../../../../../test/helpers';
import {processCleanup} from '../api-request-cleanup-processor.js';

/** Plunk Lite: old API request logs are deleted in bounded batches */
describe('API request cleanup', () => {
  const prisma = getPrismaClient();

  it('deletes the old rows batch by batch and keeps the recent ones', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    const row = (createdAt?: Date) => ({
      id: crypto.randomUUID(),
      method: 'GET',
      path: '/x',
      statusCode: 200,
      duration: 1,
      createdAt,
    });
    await prisma.apiRequest.createMany({data: Array.from({length: 25}, () => row(old))});
    await prisma.apiRequest.createMany({data: Array.from({length: 3}, () => row())});

    const result = await processCleanup(createMockJob({}) as Job, 10);

    expect(result.deleted).toBe(25);
    expect(await prisma.apiRequest.count()).toBe(3);
  });
});
