import {describe, expect, it} from 'vitest';
import {EmailSourceType, EmailStatus} from '@plunk/db';

import {processCleanup} from '../email-body-cleanup-processor';
import {createMockJob, factories, getPrismaClient} from '../../../../../test/helpers';

describe('processCleanup', () => {
  const prisma = getPrismaClient();
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const attachments = [{filename: 'guide.pdf', content: 'JVBERi0xLjQK', contentType: 'application/pdf'}];
  const job = createMockJob({});

  async function sentEmail(createdAt: Date, withAttachments: boolean) {
    const {project} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: project.id});
    return prisma.email.create({
      data: {
        projectId: project.id,
        contactId: contact.id,
        subject: 'Hello',
        body: '<p>Hello</p>',
        from: 'hello@plunk.test',
        sourceType: EmailSourceType.TRANSACTIONAL,
        status: EmailStatus.DELIVERED,
        attachments: withAttachments ? attachments : undefined,
        createdAt,
      },
    });
  }

  it('drops the body and the attachments of an email past the retention window', async () => {
    const email = await sentEmail(daysAgo(91), true);

    await processCleanup(job);

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row?.body).toBe('');
    expect(row?.attachments).toBeNull();
  });

  it('drops the body of an old email that had no attachments', async () => {
    const email = await sentEmail(daysAgo(91), false);

    await processCleanup(job);

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row?.body).toBe('');
    expect(row?.attachments).toBeNull();
  });

  it('leaves a recent email as it was', async () => {
    const email = await sentEmail(daysAgo(10), true);

    await processCleanup(job);

    const row = await prisma.email.findUnique({where: {id: email.id}});
    expect(row?.body).toBe('<p>Hello</p>');
    expect(row?.attachments).toEqual(attachments);
  });
});
