import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {EmailStatus} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../../packages/db/prisma/migrations/20261029120000_plunk_lite_suppressions/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

/** The seeding statement of the migration that creates the suppression list, as it will run */
const backfill = migration.slice(migration.indexOf('INSERT INTO'));

/**
 * The migration seeds the list with the bounces and complaints already recorded, but only for
 * contacts unsubscribed today: one resubscribed since was resubscribed on purpose.
 */
describe('suppression list seeding', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await prisma.plunkLiteSuppression.deleteMany({});
  });

  async function emailTo(
    subscribed: boolean,
    data: {status: EmailStatus; bouncedAt?: Date; complainedAt?: Date; simulated?: boolean; headers?: object},
  ) {
    const contact = await factories.createContact({projectId, subscribed});
    await prisma.email.create({
      data: {
        projectId,
        contactId: contact.id,
        subject: 'News',
        body: '<p>news</p>',
        from: 'hello@plunk.test',
        sourceType: 'CAMPAIGN',
        sentAt: new Date(),
        ...data,
      },
    });
    return contact.email;
  }

  it('suppresses the unsubscribed contacts that bounced or complained, and nobody else', async () => {
    const bounced = await emailTo(false, {status: EmailStatus.BOUNCED, bouncedAt: new Date()});
    const complained = await emailTo(false, {status: EmailStatus.COMPLAINED, complainedAt: new Date()});
    // An address SES already had on its account list: no timestamp, only the status
    const accountListed = await emailTo(false, {status: EmailStatus.BOUNCED});
    await emailTo(true, {status: EmailStatus.BOUNCED, bouncedAt: new Date()});
    await emailTo(false, {status: EmailStatus.BOUNCED, bouncedAt: new Date(), simulated: true});
    await emailTo(false, {
      status: EmailStatus.BOUNCED,
      bouncedAt: new Date(),
      headers: {'X-Plunk-Recipient-Override': 'team@else.test'},
    });
    await emailTo(false, {status: EmailStatus.DELIVERED});

    await prisma.$executeRawUnsafe(backfill);

    const rows = await prisma.plunkLiteSuppression.findMany({where: {projectId}, orderBy: {email: 'asc'}});
    expect(Object.fromEntries(rows.map(row => [row.email, row.reason]))).toEqual({
      [bounced]: 'BOUNCE',
      [complained]: 'COMPLAINT',
      [accountListed]: 'BOUNCE',
    });
  });
});
