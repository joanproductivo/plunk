import type {NextFunction, Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';
import {ZodError} from 'zod';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ValidationError} from '../../exceptions/index.js';
import {Events} from '../Events';

/** Plunk Lite: POST /events/track is for a contact, within /v1/track's limits, and never a reserved event */
describe('Events Controller - track', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  /** Run the handler and resolve with the response status, or the error passed to next */
  function track(body: unknown) {
    return new Promise<{status?: number; error?: unknown}>(resolve => {
      const res = {
        locals: {auth: {projectId}},
        status: (status: number) => ({json: () => resolve({status})}),
      } as unknown as Response;
      const next: NextFunction = error => resolve({error});
      void new Events().track({body} as Request, res, next);
    });
  }

  it('records an event for a contact of the project', async () => {
    expect(await track({name: 'signup', contactId, data: {plan: 'pro'}})).toEqual({status: 201});
    expect(await prisma.event.count({where: {projectId, name: 'signup', contactId}})).toBe(1);
  });

  it('refuses an event without a contact', async () => {
    expect((await track({name: 'signup'})).error).toBeInstanceOf(ZodError);
    expect(await prisma.event.count({where: {projectId}})).toBe(0);
  });

  it('refuses a reserved event', async () => {
    const {error} = await track({name: 'email.open', contactId});

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors[0]).toMatchObject({field: 'name', code: 'reserved_event'});
  });

  it('refuses data over the /v1/track limits, and a name with a line break', async () => {
    expect((await track({name: 'signup', contactId, data: {notes: 'x'.repeat(33 * 1024)}})).error).toBeInstanceOf(
      ZodError,
    );
    expect((await track({name: 'sign\nup', contactId})).error).toBeInstanceOf(ZodError);
  });
});
