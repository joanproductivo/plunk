import type {ContactImportJobData} from '@plunk/types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createMockJob, factories, getPrismaClient} from '../../../../../test/helpers';
import {CONTACT_FIELDS_MAX, ContactService} from '../../services/ContactService.js';
import {SegmentService} from '../../services/SegmentService.js';
import {coerceCustomValue, importCustomData, importFieldKey, parseImportCsv, splitImportRecord} from '../import-csv.js';
import {dropFinishedCsv, processContactImport} from '../import-processor.js';
import {importQueue, QueueService} from '../../services/QueueService.js';

/**
 * Tests for Contact Import Processor - Subscription Status Preservation
 * Verifies that CSV imports preserve subscription status correctly
 */
describe('Contact Import - Subscription Status Preservation', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  describe('Existing contacts', () => {
    it('should NOT change subscription status when CSV has no subscribed column for subscribed contact', async () => {
      // Create a subscribed contact
      const contact = await factories.createContact({
        projectId,
        subscribed: true,
        email: 'existing-subscribed@example.com',
      });

      // Verify initial state
      expect(contact.subscribed).toBe(true);

      // Simulate import without subscribed column (undefined)
      await ContactService.upsert(projectId, contact.email, {firstName: 'John'}, undefined);

      // Verify subscription status unchanged
      const updated = await prisma.contact.findUnique({
        where: {id: contact.id},
      });

      expect(updated?.subscribed).toBe(true);
    });

    it('should NOT re-subscribe unsubscribed contact when CSV has no subscribed column', async () => {
      // Create an unsubscribed contact
      const contact = await factories.createContact({
        projectId,
        subscribed: false,
        email: 'existing-unsubscribed@example.com',
      });

      // Verify initial state
      expect(contact.subscribed).toBe(false);

      // Simulate import without subscribed column (undefined)
      await ContactService.upsert(projectId, contact.email, {firstName: 'Jane'}, undefined);

      // Verify subscription status unchanged (should NOT be re-subscribed)
      const updated = await prisma.contact.findUnique({
        where: {id: contact.id},
      });

      expect(updated?.subscribed).toBe(false);
    });

    it('should update subscription status when CSV explicitly has subscribed=true', async () => {
      // Create an unsubscribed contact
      const contact = await factories.createContact({
        projectId,
        subscribed: false,
        email: 'import-resubscribe@example.com',
      });

      // Verify initial state
      expect(contact.subscribed).toBe(false);

      // Simulate import with explicit subscribed=true
      await ContactService.upsert(projectId, contact.email, {firstName: 'John'}, true);

      // Verify subscription status changed
      const updated = await prisma.contact.findUnique({
        where: {id: contact.id},
      });

      expect(updated?.subscribed).toBe(true);
    });

    it('should update subscription status when CSV explicitly has subscribed=false', async () => {
      // Create a subscribed contact
      const contact = await factories.createContact({
        projectId,
        subscribed: true,
        email: 'import-unsubscribe@example.com',
      });

      // Verify initial state
      expect(contact.subscribed).toBe(true);

      // Simulate import with explicit subscribed=false
      await ContactService.upsert(projectId, contact.email, {firstName: 'Jane'}, false);

      // Verify subscription status changed
      const updated = await prisma.contact.findUnique({
        where: {id: contact.id},
      });

      expect(updated?.subscribed).toBe(false);
    });
  });

  describe('New contacts', () => {
    it('should create new contact as subscribed when CSV has no subscribed column', async () => {
      const newEmail = 'new-import-default@example.com';

      // Simulate import without subscribed column (undefined)
      const contact = await ContactService.upsert(projectId, newEmail, {firstName: 'New'}, undefined);

      // New contacts should default to subscribed=true
      expect(contact.subscribed).toBe(true);
    });

    it('should create new contact as subscribed when CSV explicitly has subscribed=true', async () => {
      const newEmail = 'new-import-explicit-sub@example.com';

      // Simulate import with explicit subscribed=true
      const contact = await ContactService.upsert(projectId, newEmail, {firstName: 'New'}, true);

      expect(contact.subscribed).toBe(true);
    });

    it('should create new contact as unsubscribed when CSV explicitly has subscribed=false', async () => {
      const newEmail = 'new-import-explicit-unsub@example.com';

      // Simulate import with explicit subscribed=false
      const contact = await ContactService.upsert(projectId, newEmail, {firstName: 'New'}, false);

      expect(contact.subscribed).toBe(false);
    });
  });

  describe('CSV parsing logic', () => {
    it('should parse "true" string as boolean true', () => {
      const subscribedValue = 'true';
      const lowerValue = subscribedValue.toLowerCase().trim();
      const subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';

      expect(subscribed).toBe(true);
    });

    it('should parse "1" string as boolean true', () => {
      const subscribedValue = '1';
      const lowerValue = subscribedValue.toLowerCase().trim();
      const subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';

      expect(subscribed).toBe(true);
    });

    it('should parse "yes" string as boolean true', () => {
      const subscribedValue = 'yes';
      const lowerValue = subscribedValue.toLowerCase().trim();
      const subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';

      expect(subscribed).toBe(true);
    });

    it('should parse "false" string as boolean false', () => {
      const subscribedValue = 'false';
      const lowerValue = subscribedValue.toLowerCase().trim();
      const subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';

      expect(subscribed).toBe(false);
    });

    it('should parse "0" string as boolean false', () => {
      const subscribedValue = '0';
      const lowerValue = subscribedValue.toLowerCase().trim();
      const subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';

      expect(subscribed).toBe(false);
    });

    it('should parse "no" string as boolean false', () => {
      const subscribedValue = 'no';
      const lowerValue = subscribedValue.toLowerCase().trim();
      const subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';

      expect(subscribed).toBe(false);
    });

    it('should handle empty string as undefined', () => {
      const subscribedValue = '';
      let subscribed: boolean | undefined;

      if (subscribedValue !== undefined && subscribedValue !== '') {
        const lowerValue = subscribedValue.toLowerCase().trim();
        subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';
      }

      expect(subscribed).toBeUndefined();
    });

    it('should handle undefined as undefined', () => {
      const subscribedValue = undefined;
      let subscribed: boolean | undefined;

      if (subscribedValue !== undefined && subscribedValue !== '') {
        const lowerValue = subscribedValue.toLowerCase().trim();
        subscribed = lowerValue === 'true' || lowerValue === '1' || lowerValue === 'yes';
      }

      expect(subscribed).toBeUndefined();
    });
  });

  describe('Data preservation', () => {
    it('should preserve existing contact data while updating subscription', async () => {
      // Create contact with existing data
      const contact = await factories.createContact({
        projectId,
        subscribed: false,
        email: 'preserve-data@example.com',
        data: {
          firstName: 'Original',
          lastName: 'Name',
          plan: 'pro',
        },
      });

      // Update only subscription via import
      await ContactService.upsert(projectId, contact.email, {}, true);

      const updated = await prisma.contact.findUnique({
        where: {id: contact.id},
      });

      // Subscription should be updated
      expect(updated?.subscribed).toBe(true);

      // Original data should be preserved
      const data = updated?.data as Record<string, unknown>;
      expect(data?.firstName).toBe('Original');
      expect(data?.lastName).toBe('Name');
      expect(data?.plan).toBe('pro');
    });

    it('should merge new data while preserving subscription', async () => {
      // Create contact with existing data
      const contact = await factories.createContact({
        projectId,
        subscribed: false,
        email: 'merge-data@example.com',
        data: {
          firstName: 'John',
          plan: 'pro',
        },
      });

      // Import new data without changing subscription
      await ContactService.upsert(
        projectId,
        contact.email,
        {
          lastName: 'Doe',
          company: 'Acme Inc',
        },
        undefined,
      );

      const updated = await prisma.contact.findUnique({
        where: {id: contact.id},
      });

      // Subscription should be unchanged
      expect(updated?.subscribed).toBe(false);

      // Data should be merged
      const data = updated?.data as Record<string, unknown>;
      expect(data?.firstName).toBe('John'); // Preserved
      expect(data?.plan).toBe('pro'); // Preserved
      expect(data?.lastName).toBe('Doe'); // New
      expect(data?.company).toBe('Acme Inc'); // New
    });
  });
});

describe('coerceCustomValue', () => {
  describe('boolean coercion', () => {
    it.each(['true', 'TRUE', 'True', ' true ', 'yes', 'YES', 'Yes'])('coerces %j to true', value => {
      expect(coerceCustomValue(value)).toBe(true);
    });

    it.each(['false', 'FALSE', 'False', ' false ', 'no', 'NO', 'No'])('coerces %j to false', value => {
      expect(coerceCustomValue(value)).toBe(false);
    });
  });

  describe('number coercion', () => {
    it.each([
      ['42', 42],
      ['-7', -7],
      ['3.14', 3.14],
      [' 42 ', 42],
      ['0.5', 0.5],
      ['-0.25', -0.25],
      ['0', 0],
      ['1', 1],
    ])('coerces %j to %j', (value, expected) => {
      expect(coerceCustomValue(value)).toBe(expected);
    });

    it.each(['01234', '+42', '.5', '42.', '1e10', 'NaN', 'Infinity', '1.2.3', '4-2'])(
      'leaves %j as a string (preserves IDs / rejects loose formats)',
      value => {
        expect(coerceCustomValue(value)).toBe(value);
      },
    );

    it('"1.0" is a number (does not match the boolean truthy set)', () => {
      expect(coerceCustomValue('1.0')).toBe(1);
    });
  });

  describe('passthrough', () => {
    it.each(['Alice', 'true!', 'yesno', 'maybe'])('leaves %j as a string', value => {
      expect(coerceCustomValue(value)).toBe(value);
    });

    it('leaves empty string as empty string', () => {
      expect(coerceCustomValue('')).toBe('');
    });
  });
});

describe('parseImportCsv', () => {
  it('undoes the export formula escaping on headers too', () => {
    expect(parseImportCsv("email,'=Key\r\nana@example.com,1\r\n")).toEqual([{'email': 'ana@example.com', '=key': '1'}]);
  });

  it('drops a UTF-8 byte order mark so the email column is still found', () => {
    expect(parseImportCsv('\uFEFFEmail,Name\r\nana@example.com,Ana\r\n')).toEqual([
      {email: 'ana@example.com', name: 'Ana'},
    ]);
  });
});

describe('splitImportRecord', () => {
  it('skips the read-only columns the export writes, but keeps segments, status and createdAt apart', () => {
    const split = splitImportRecord({
      email: ' ana@example.com ',
      subscribed: 'true',
      status: 'subscribed',
      createdat: '2026-10-25T10:00:00.000Z',
      updatedat: '2026-10-25T10:00:00.000Z',
      segments: 'Club; VIP',
      dynamicsegments: 'Engaged',
      plan: 'pro',
    });

    expect(split).toEqual({
      email: 'ana@example.com',
      subscribed: true,
      keepSnooze: false,
      data: {plan: 'pro'},
      segments: 'Club; VIP',
      createdAt: new Date('2026-10-25T10:00:00.000Z'),
      invalidCreatedAt: false,
    });
  });

  it('undoes the export formula escaping on every cell', () => {
    const split = splitImportRecord({email: 'ana@example.com', formula: "'=1+1", handle: "'@ana", note: "it's"});

    expect(split.data).toEqual({formula: '=1+1', handle: '@ana', note: "it's"});
  });

  it('flags an unchanged exported snooze so it is not turned into an unsubscribe', () => {
    const snoozed = splitImportRecord({email: 'a@example.com', subscribed: 'false', status: 'snoozed'});
    expect(snoozed).toMatchObject({subscribed: false, keepSnooze: true});

    // Edited to subscribed=true, the row is a decision to resubscribe and is honoured.
    expect(splitImportRecord({email: 'a@example.com', subscribed: 'true', status: 'snoozed'})).toMatchObject({
      subscribed: true,
      keepSnooze: false,
    });
    expect(splitImportRecord({email: 'a@example.com', subscribed: 'false', status: 'unsubscribed'})).toMatchObject({
      subscribed: false,
      keepSnooze: false,
    });
  });

  it('fills a custom field from a data. column without touching the column of the same name', () => {
    const split = splitImportRecord({'email': 'a@example.com', 'status': 'unsubscribed', 'data.status': 'gold'});

    expect(split.statusSubscription).toBe(false);
    expect(split.data).toEqual({status: 'gold'});
  });

  it('writes no custom data when only reserved columns are present', () => {
    expect(splitImportRecord({email: 'a@example.com', status: 'subscribed'}).data).toBeUndefined();
  });
});

describe('processContactImport', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
  });

  const runImport = (csv: string) =>
    processContactImport(
      createMockJob<ContactImportJobData>({
        projectId,
        csvData: Buffer.from(csv).toString('base64'),
        filename: 'contacts.csv',
      }),
    );

  const contactNamed = (email: string) => prisma.contact.findFirstOrThrow({where: {projectId, email}});
  const subscriptionEvents = (contactId: string) =>
    prisma.event.count({where: {contactId, name: {in: ['contact.subscribed', 'contact.unsubscribed']}}});

  it('suppresses the addresses the source reports as bounced, cleaned or complained', async () => {
    // Subscribed here, but bounced at the source: the file decides
    await factories.createContact({projectId, email: 'was-subscribed@plunk.test', subscribed: true});

    const result = await runImport(
      [
        'email,status',
        'was-subscribed@plunk.test,bounced',
        'cleaned@plunk.test,cleaned',
        'spam@plunk.test,complained',
        'fine@plunk.test,subscribed',
      ].join('\n'),
    );

    const reasons = Object.fromEntries(
      (await prisma.plunkLiteSuppression.findMany({where: {projectId}})).map(row => [row.email, row.reason]),
    );
    expect(reasons).toEqual({
      'was-subscribed@plunk.test': 'BOUNCE',
      'cleaned@plunk.test': 'BOUNCE',
      'spam@plunk.test': 'COMPLAINT',
    });
    expect((await contactNamed('was-subscribed@plunk.test')).subscribed).toBe(false);
    expect((await contactNamed('cleaned@plunk.test')).subscribed).toBe(false);
    expect((await contactNamed('fine@plunk.test')).subscribed).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringContaining('Bounced, cleaned or complained in 3 rows'));
  });

  it('imports a dotted date column that within and olderThan filters can use', async () => {
    // Flodesk writes dates without milliseconds; the filters compare against toISOString(), with them
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    await runImport(`email,metafields.lastOpen\nrecent@example.test,${daysAgo(1)}\nold@example.test,${daysAgo(40)}`);

    const matching = async (operator: 'within' | 'olderThan') => {
      const where = await SegmentService.buildConditionClause(projectId, {
        logic: 'AND',
        groups: [{filters: [{field: 'data.metafields_lastopen', operator, value: 30, unit: 'days'}]}],
      });
      const contacts = await prisma.contact.findMany({where: {projectId, ...where}, select: {email: true}});
      return contacts.map(contact => contact.email);
    };
    expect(await matching('within')).toEqual(['recent@example.test']);
    expect(await matching('olderThan')).toEqual(['old@example.test']);
  });

  it('imports a row shaped like the Flodesk export: date, opt-out and three segments', async () => {
    const result = await runImport(
      [
        'id,email,firstName,lastName,source,status,createdAt,segments,metafields.lastIp,metafields.lastOpen',
        'f1,ana@example.test,Ana,Ruiz,form,unsubscribed,2023-04-05T08:09:10Z,"Club, Ventas, Newsletter",192.0.2.1,',
        'f2,bo@example.test,Bo,Li,form,confirmed,2022-01-02T03:04:05Z,Club,,',
      ].join('\n'),
    );

    expect(result).toMatchObject({createdCount: 2, failureCount: 0, errors: [], warnings: []});
    const ana = await contactNamed('ana@example.test');
    expect(ana.createdAt).toEqual(new Date('2023-04-05T08:09:10Z'));
    expect(ana.subscribed).toBe(false);
    expect(ana.data).toEqual({
      firstname: 'Ana',
      lastname: 'Ruiz',
      source: 'form',
      metafields_lastip: '192.0.2.1',
    });
    const bo = await contactNamed('bo@example.test');
    expect(bo.createdAt).toEqual(new Date('2022-01-02T03:04:05Z'));
    expect(bo.subscribed).toBe(true);

    const segments = await prisma.segment.findMany({
      where: {projectId},
      select: {name: true, type: true, memberships: {where: {exitedAt: null}, select: {contactId: true}}},
      orderBy: {name: 'asc'},
    });
    expect(segments.map(s => [s.name, s.type, s.memberships.length])).toEqual([
      ['Club', 'STATIC', 2],
      ['Newsletter', 'STATIC', 1],
      ['Ventas', 'STATIC', 1],
    ]);
  });

  it('keeps the date of an existing contact, and never resubscribes one from status', async () => {
    const optedOut = await factories.createContact({projectId, email: 'out@example.test', subscribed: false});

    const result = await runImport('email,status,createdAt\nout@example.test,confirmed,2020-01-01T00:00:00Z');

    expect(result.updatedCount).toBe(1);
    const after = await contactNamed('out@example.test');
    expect(after.subscribed).toBe(false);
    expect(after.createdAt).toEqual(optedOut.createdAt);
    expect(await subscriptionEvents(optedOut.id)).toBe(0);
  });

  it('unsubscribes an existing contact whose status says so', async () => {
    const subscribed = await factories.createContact({projectId, email: 'in@example.test', subscribed: true});

    await runImport('email,status\nin@example.test,unsubscribed');

    expect((await contactNamed('in@example.test')).subscribed).toBe(false);
    expect(await prisma.event.count({where: {contactId: subscribed.id, name: 'contact.unsubscribed'}})).toBe(1);
  });

  it('leaves an existing contact alone on a status that is not an opt-out, but imports a new one unsubscribed', async () => {
    const subscribed = await factories.createContact({projectId, email: 'kept@example.test', subscribed: true});

    // `inactive` is not mailable at the source but says nothing about the address; a bounce does
    // (see the suppression test)
    const result = await runImport('email,status\nkept@example.test,inactive\nfresh@example.test,unconfirmed');

    expect((await contactNamed('kept@example.test')).subscribed).toBe(true);
    expect(await prisma.event.count({where: {contactId: subscribed.id}})).toBe(0);
    expect((await contactNamed('fresh@example.test')).subscribed).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('imports new contacts with an unknown status unsubscribed, and warns once per status', async () => {
    const result = await runImport(
      'email,subscribed,status,createdAt\nx@example.test,,Weird,2026-02-30\ny@example.test,,weird,\nz@example.test,,,',
    );

    expect(result).toMatchObject({createdCount: 3, failureCount: 0, errors: []});
    expect(result.warnings).toEqual([
      'createdAt is not an ISO 8601 date from 1990 to a day ahead in 1 row: those new contacts were dated today',
      'Unknown status "weird" in 2 rows: new contacts were imported unsubscribed, existing ones left as they were',
    ]);
    expect((await contactNamed('x@example.test')).subscribed).toBe(false);
    expect((await contactNamed('y@example.test')).subscribed).toBe(false);
    // Blank subscribed and status cells: created subscribed, as before
    expect((await contactNamed('z@example.test')).subscribed).toBe(true);
  });

  it('caps the unknown statuses it lists one by one', async () => {
    const rows = Array.from({length: 12}, (_, n) => `s${n}@example.test,state-${n}`);

    const {warnings} = await runImport(['email,status', ...rows].join('\n'));

    expect(warnings).toHaveLength(11);
    expect(warnings?.at(-1)).toBe('Other unknown statuses in 2 rows, handled the same way');
  });
});

describe('processContactImport: existing contacts and edge rows', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runImport = (csv: string) =>
    processContactImport(
      createMockJob<ContactImportJobData>({
        projectId,
        csvData: Buffer.from(csv).toString('base64'),
        filename: 'contacts.csv',
      }),
    );
  const contactNamed = (email: string) => prisma.contact.findFirstOrThrow({where: {projectId, email}});

  it('treats a contact created after the existence check as existing', async () => {
    const optedOut = await factories.createContact({projectId, email: 'race@example.test', subscribed: false});
    // As if another import or the API created the contact between the check and the write
    vi.spyOn(ContactService, 'findByEmail').mockResolvedValue(null);

    await runImport('email,status,createdAt\nrace@example.test,confirmed,2020-01-01T00:00:00Z');

    const after = await contactNamed('race@example.test');
    expect(after.subscribed).toBe(false);
    expect(after.createdAt).toEqual(optedOut.createdAt);
    expect(await prisma.event.count({where: {contactId: optedOut.id}})).toBe(0);
  });

  it('neither warns about nor applies the date of an existing contact', async () => {
    await factories.createContact({projectId, email: 'old@example.test'});

    const result = await runImport('email,createdAt\nold@example.test,not a date');

    expect(result.warnings).toEqual([]);
  });

  it('keeps a snooze, and leaves a contact with an unknown status as it is but warns', async () => {
    const snoozedUntil = new Date('2030-01-01T00:00:00Z');
    await prisma.contact.create({
      data: {projectId, email: 'zz@example.test', subscribed: false, snoozedUntil},
    });
    await factories.createContact({projectId, email: 'odd@example.test', subscribed: true});

    const result = await runImport('email,status\nzz@example.test,snoozed\nodd@example.test,vip');

    expect(await contactNamed('zz@example.test')).toMatchObject({subscribed: false, snoozedUntil});
    expect((await contactNamed('odd@example.test')).subscribed).toBe(true);
    expect(result.warnings).toEqual([
      'Unknown status "vip" in 1 row: new contacts were imported unsubscribed, existing ones left as they were',
    ]);
  });

  it('imports a new contact with no status unsubscribed when only status speaks for the file', async () => {
    const result = await runImport(
      'email,status\nfull@example.test,confirmed\nshort@example.test\nblank@example.test,',
    );

    expect((await contactNamed('full@example.test')).subscribed).toBe(true);
    expect((await contactNamed('short@example.test')).subscribed).toBe(false);
    expect((await contactNamed('blank@example.test')).subscribed).toBe(false);
    expect(result.warnings).toEqual([
      'No status in 2 rows: new contacts were imported unsubscribed, existing ones left as they were',
    ]);
  });

  it('still subscribes a new contact whose subscribed and status cells are both blank', async () => {
    await runImport('email,subscribed,status\nnew@example.test,,');

    expect((await contactNamed('new@example.test')).subscribed).toBe(true);
  });

  it('brings back a single segment name with a comma from an export into another project', async () => {
    const leads = await prisma.segment.create({data: {projectId, name: 'Leads', type: 'STATIC'}});

    const result = await runImport(
      'email,subscribed,status,createdAt,updatedAt,segments,dynamicSegments\n' +
        'ana@example.test,true,subscribed,2024-01-01T00:00:00.000Z,2024-01-01T00:00:00.000Z,"Leads, no clientes",',
    );

    expect(result.segmentsCreated).toEqual(['Leads, no clientes']);
    expect(await prisma.segmentMembership.count({where: {segmentId: leads.id}})).toBe(0);
  });
});

describe('ContactService.upsert createdAt', () => {
  it('dates a new contact and leaves an existing one alone', async () => {
    const {project} = await factories.createUserWithProject();
    const createdAt = new Date('2021-03-04T05:06:07Z');

    const created = await ContactService.upsert(project.id, 'new@example.test', undefined, undefined, true, {
      createdAt,
    });
    expect(created.createdAt).toEqual(createdAt);

    const existing = await factories.createContact({projectId: project.id, email: 'old@example.test'});
    const updated = await ContactService.upsert(project.id, 'old@example.test', {plan: 'pro'}, undefined, true, {
      createdAt,
    });
    expect(updated.createdAt).toEqual(existing.createdAt);
  });
});

describe('importFieldKey', () => {
  it('stores a dot in a column name as an underscore, so filters and templates can reach it', () => {
    expect(importFieldKey('metafields.lastopen')).toBe('metafields_lastopen');
    expect(importFieldKey('a..b')).toBe('a__b');
  });

  it('drops a leading data. prefix', () => {
    expect(importFieldKey('data.plan')).toBe('plan');
    expect(importFieldKey('data.a.b')).toBe('a_b');
    expect(importFieldKey('data.')).toBe('data_');
  });

  it('leaves other names alone', () => {
    expect(importFieldKey('plan')).toBe('plan');
    expect(importFieldKey('first name')).toBe('first name');
    expect(importFieldKey('database')).toBe('database');
  });
});

describe('importCustomData', () => {
  it('fills each field from its column, coercing the values', () => {
    expect(importCustomData({'plan': 'pro', 'metafields.lastopen': '2026-10-24T20:35:24Z', 'age': '42'})).toEqual({
      plan: 'pro',
      metafields_lastopen: '2026-10-24T20:35:24Z',
      age: 42,
    });
    expect(importCustomData({})).toBeUndefined();
  });

  it('never lets an empty cell erase another column filling the same field', () => {
    expect(importCustomData({'plan': 'pro', 'data.plan': ''})).toEqual({plan: 'pro'});
    expect(importCustomData({'plan': '', 'data.plan': 'pro'})).toEqual({plan: 'pro'});
    expect(importCustomData({'a.b': 'one', 'a_b': 'two'})).toEqual({a_b: 'two'});
  });

  it('keeps an unusual field name as its own key', () => {
    const data = importCustomData({'data.__proto__': 'x'});
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.keys(data!)).toEqual(['__proto__']);
  });
});

/** Plunk Lite: a finished import's CSV leaves Redis, and its status never carries it */
describe('Contact Import - the CSV after the import', () => {
  const job = (attemptsMade: number) =>
    createMockJob<ContactImportJobData>(
      {projectId: 'p', csvData: 'Y3N2', filename: 'contacts.csv'},
      {attemptsMade, opts: {attempts: 2}},
    );

  it('drops the CSV of a completed import', async () => {
    const completed = job(1);
    await dropFinishedCsv(completed, 'completed');

    expect(completed.updateData).toHaveBeenCalledWith(expect.objectContaining({csvData: '', filename: 'contacts.csv'}));
  });

  it('keeps it for a retry, and drops it once no attempt is left', async () => {
    const retrying = job(1);
    const exhausted = job(2);
    await dropFinishedCsv(retrying, 'failed');
    await dropFinishedCsv(exhausted, 'failed');

    expect(retrying.updateData).not.toHaveBeenCalled();
    expect(exhausted.updateData).toHaveBeenCalledWith(expect.objectContaining({csvData: ''}));
  });

  it('reports the status without the CSV', async () => {
    const added = await importQueue.add('import', {projectId: 'p', csvData: 'Y3N2', filename: 'contacts.csv'});
    try {
      const status = await QueueService.getImportJobStatus(added.id!, 'p');

      expect(status).toMatchObject({filename: 'contacts.csv'});
      expect(JSON.stringify(status)).not.toContain('Y3N2');
    } finally {
      await added.remove();
    }
  });

  it('fails only the row that takes a contact past the field cap', async () => {
    const {
      project: {id: projectId},
    } = await factories.createUserWithProject();
    const columns = Array.from({length: CONTACT_FIELDS_MAX + 1}, (_, i) => `field${i}`);
    const csv = [
      ['email', ...columns].join(','),
      ['wide@plunk.test', ...columns.map(() => 'x')].join(','),
      ['fine@plunk.test', ...columns.map(() => '')].join(','),
    ].join('\n');

    const result = await processContactImport(
      createMockJob<ContactImportJobData>({projectId, csvData: Buffer.from(csv).toString('base64'), filename: 'c.csv'}),
    );

    expect(result.failureCount).toBe(1);
    expect(result.errors[0]).toMatchObject({email: 'wide@plunk.test'});
    expect(result.createdCount).toBe(1);
  });
});
