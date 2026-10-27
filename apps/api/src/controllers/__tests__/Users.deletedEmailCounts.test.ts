import type {Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';

import {EmailStatus} from '@plunk/db';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ContactService} from '../../services/ContactService';
import {ReputationPolicy} from '../../services/ReputationPolicy';
import {Users} from '../Users';

/** Calls a project handler as Express would, as in Users.reactivate.test.ts */
async function call(handler: 'resetProject' | 'deleteProject', userId: string, projectId: string) {
  let status = 200;
  let error: unknown;

  await new Promise<void>(resolve => {
    const res = {
      locals: {auth: {type: 'jwt', userId}},
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        resolve();
        return this;
      },
    } as unknown as Response;
    void new Users()[handler]({params: {id: projectId}} as unknown as Request, res, (thrown?: unknown) => {
      error = thrown;
      resolve();
    });
  });

  return {status, error};
}

/**
 * Plunk Lite: resetting a project deletes its emails and keeps counting them in its rates, as AWS
 * does (DeletedEmailCounts); deleting the project deletes those counts, which have no relation to it.
 */
describe('Projects and the counts of their deleted emails', () => {
  const prisma = getPrismaClient();
  let userId: string;
  let projectId: string;

  beforeEach(async () => {
    const {user, project} = await factories.createUserWithProject();
    userId = user.id;
    projectId = project.id;
  });

  async function bouncedContact(project: string) {
    const contact = await factories.createContact({projectId: project});
    // In one same minute, which the deleted ones are counted by
    const createdAt = new Date();
    await prisma.email.createMany({
      data: [true, false].map(bounced => ({
        projectId: project,
        contactId: contact.id,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        sourceType: 'TRANSACTIONAL' as const,
        status: EmailStatus.SENT,
        sentAt: createdAt,
        createdAt,
        bouncedAt: bounced ? createdAt : null,
      })),
    });
    return contact;
  }

  it('a reset deletes the emails and keeps the rates', async () => {
    await bouncedContact(projectId);
    const before = await ReputationPolicy.rates({projectId});
    expect(before).toMatchObject({total: 2, bounces: 1});

    const {status, error} = await call('resetProject', userId, projectId);

    expect(error).toBeUndefined();
    expect(status).toBe(200);
    expect(await prisma.email.count({where: {projectId}})).toBe(0);
    expect(await prisma.contact.count({where: {projectId}})).toBe(0);
    expect(await ReputationPolicy.rates({projectId})).toEqual(before);
  });

  it('deleting the project deletes its counts, and no other project’s', async () => {
    const other = await factories.createUserWithProject();
    await ContactService.delete(projectId, (await bouncedContact(projectId)).id);
    await ContactService.delete(other.project.id, (await bouncedContact(other.project.id)).id);
    expect(await prisma.plunkLiteDeletedEmailCount.count({where: {projectId}})).toBe(1);

    const {status, error} = await call('deleteProject', userId, projectId);

    expect(error).toBeUndefined();
    expect(status).toBe(200);
    expect(await prisma.project.count({where: {id: projectId}})).toBe(0);
    expect(await prisma.plunkLiteDeletedEmailCount.count({where: {projectId}})).toBe(0);
    expect(await prisma.plunkLiteDeletedEmailCount.count({where: {projectId: other.project.id}})).toBe(1);
  });
});
