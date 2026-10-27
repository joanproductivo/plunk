import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {EmailStatus} from '@plunk/db';

import {QueueService} from '../../services/QueueService';
import {getAwsAccountId} from '../../services/SESService';
import {SnsSignature} from '../../services/SnsSignature';
import {post} from './snsWebhook';
import {factories, getPrismaClient} from '../../../../../test/helpers';

vi.mock('../../services/SESService', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService')>()),
  getAwsAccountId: vi.fn(),
  sendRawEmail: vi.fn(async () => ({messageId: 'alert-message-id'})),
}));

/**
 * A Reject: SES accepted the email and then refused to deliver it for its content. The email
 * failed; the address did nothing wrong.
 */
describe('Webhooks - SES rejects', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId, subscribed: true})).id;
    vi.spyOn(SnsSignature, 'verify').mockResolvedValue('valid');
    vi.mocked(getAwsAccountId).mockResolvedValue('111111111111');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const emailRow = (status: EmailStatus, messageId?: string) =>
    prisma.email.create({
      data: {
        projectId,
        contactId,
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'hello@plunk.test',
        sourceType: 'TRANSACTIONAL',
        status,
        ...(messageId && {messageId, sentAt: new Date()}),
      },
    });

  it('fails the email and alerts, without suppressing or unsubscribing anyone', async () => {
    const track = vi.spyOn(QueueService, 'queueEventTracking');
    const email = await emailRow(EmailStatus.SENT, 'ses-rejected');

    const captured = await post({
      eventType: 'Reject',
      mail: {messageId: 'ses-rejected', timestamp: new Date().toISOString()},
      reject: {reason: 'Bad content'},
    });

    expect(captured.status).toBe(200);
    expect(await prisma.email.findUniqueOrThrow({where: {id: email.id}})).toMatchObject({
      status: EmailStatus.FAILED,
      error: 'Rejected by SES: Bad content',
    });
    expect(await prisma.plunkLiteFailure.findFirst({where: {projectId, sourceKey: 'transactional'}})).toMatchObject({
      lastError: 'Rejected by SES: Bad content',
    });
    expect(await prisma.plunkLiteSuppression.count({where: {projectId}})).toBe(0);
    expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).subscribed).toBe(true);
    expect(track).not.toHaveBeenCalled();
  });

  it('waits for an email whose send is still being recorded', async () => {
    const email = await emailRow(EmailStatus.SENDING);

    const captured = await post({
      eventType: 'Reject',
      mail: {
        messageId: 'ses-rejected-early',
        timestamp: new Date().toISOString(),
        destination: [(await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).email],
        tags: {plunk_email_id: [email.id], plunk_project_id: [projectId]},
      },
      reject: {reason: 'Bad content'},
    });

    expect(captured.status).toBe(503);
    expect((await prisma.email.findUniqueOrThrow({where: {id: email.id}})).status).toBe(EmailStatus.SENDING);
  });
});
