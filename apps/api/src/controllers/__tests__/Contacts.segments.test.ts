import type {NextFunction, Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Contacts} from '../Contacts';

describe('Contacts Controller - GET /contacts/:id/segments', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  /** Run the handler and resolve with the response, or the error passed to next */
  function call(contactId: string) {
    return new Promise<{status?: number; body?: unknown; error?: unknown}>(resolve => {
      const res = {
        locals: {auth: {projectId}},
        status: (status: number) => ({json: (body: unknown) => resolve({status, body})}),
      } as unknown as Response;
      const next: NextFunction = error => resolve({error});
      void new Contacts().segments({params: {id: contactId}} as unknown as Request, res, next);
    });
  }

  it("returns the contact's segments", async () => {
    const contact = await factories.createContact({projectId});
    const segment = await prisma.segment.create({data: {projectId, name: 'Workshop', type: 'STATIC'}});
    await prisma.segmentMembership.create({data: {segmentId: segment.id, contactId: contact.id}});

    expect(await call(contact.id)).toEqual({
      status: 200,
      body: {static: [{id: segment.id, name: 'Workshop'}], dynamic: []},
    });
  });

  it("answers 404 for another project's contact", async () => {
    const {project: other} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: other.id});

    const {error} = await call(contact.id);

    expect(error).toMatchObject({code: 404});
  });
});
