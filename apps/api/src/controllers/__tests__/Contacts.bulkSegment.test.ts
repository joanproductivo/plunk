import type {NextFunction, Request, Response} from 'express';
import type {Job} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {QueueService} from '../../services/QueueService';
import {Contacts} from '../Contacts';

describe('Contacts Controller - bulk segment actions', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    vi.spyOn(QueueService, 'queueBulkContactAction').mockResolvedValue({id: 'job-1'} as Job);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Run a route handler and resolve with the response status, or the error passed to next */
  function call(handler: 'bulkAddToSegment' | 'bulkRemoveFromSegment', body: unknown) {
    return new Promise<{status?: number; error?: unknown}>(resolve => {
      const res = {
        locals: {auth: {projectId}},
        status: (status: number) => ({json: () => resolve({status})}),
      } as unknown as Response;
      const next: NextFunction = error => resolve({error});
      void new Contacts()[handler]({body} as Request, res, next);
    });
  }

  const selector = {mode: 'query', filter: {}};

  it('queues a job for a static segment of the project', async () => {
    const segment = await prisma.segment.create({data: {projectId, name: 'Workshop', type: 'STATIC'}});

    expect(await call('bulkAddToSegment', {...selector, targetSegmentId: segment.id})).toEqual({status: 202});
    expect(QueueService.queueBulkContactAction).toHaveBeenCalledWith({
      projectId,
      operation: 'addToSegment',
      targetSegmentId: segment.id,
      selector: {mode: 'query', filter: {}, excludeIds: undefined},
    });
  });

  it('rejects a dynamic segment before queueing', async () => {
    const segment = await prisma.segment.create({
      data: {projectId, name: 'Active', type: 'DYNAMIC', condition: {logic: 'AND', groups: []}},
    });

    const {error} = await call('bulkRemoveFromSegment', {...selector, targetSegmentId: segment.id});

    expect(error).toMatchObject({code: 400, message: 'Can only remove contacts from STATIC segments'});
    expect(QueueService.queueBulkContactAction).not.toHaveBeenCalled();
  });

  it("rejects another project's segment before queueing", async () => {
    const {project: other} = await factories.createUserWithProject();
    const segment = await prisma.segment.create({data: {projectId: other.id, name: 'Theirs', type: 'STATIC'}});

    const {error} = await call('bulkAddToSegment', {...selector, targetSegmentId: segment.id});

    expect(error).toMatchObject({code: 404});
    expect(QueueService.queueBulkContactAction).not.toHaveBeenCalled();
  });

  it('requires a target segment, naming the missing field', async () => {
    const {error} = await call('bulkAddToSegment', selector);

    expect(error).toMatchObject({code: 400, message: 'targetSegmentId: Required'});
  });

  it('drops repeated contact ids', async () => {
    const segment = await prisma.segment.create({data: {projectId, name: 'Workshop', type: 'STATIC'}});
    const id = '00000000-0000-4000-8000-000000000001';

    await call('bulkAddToSegment', {mode: 'ids', contactIds: [id, id], targetSegmentId: segment.id});

    expect(QueueService.queueBulkContactAction).toHaveBeenCalledWith(
      expect.objectContaining({selector: {mode: 'ids', contactIds: [id]}}),
    );
  });
});
