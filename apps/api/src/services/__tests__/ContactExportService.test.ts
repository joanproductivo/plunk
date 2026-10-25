import type {BulkContactActionSelector} from '@plunk/types';
import {beforeEach, describe, expect, it} from 'vitest';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {parseImportCsv, splitImportRecord} from '../../jobs/import-processor.js';
import {ContactExportService} from '../ContactExportService.js';
import {ContactService} from '../ContactService.js';
import {SegmentService} from '../SegmentService.js';

/**
 * The contacts export: one streaming pass over the selected contacts, with their static and
 * dynamic segments. Small batches make every test cross batch boundaries.
 */
describe('ContactExportService', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
  });

  const emailOf = (n: number) => `c${String(n).padStart(2, '0')}@example.com`;

  const seed = async (count: number) => {
    for (let n = 0; n < count; n++) {
      await factories.createContact({
        projectId,
        email: emailOf(n),
        data: n % 2 === 0 ? {firstname: `Name ${n}`} : null,
      });
    }
  };

  const exportCsv = async (selector: BulkContactActionSelector, batchSize = 7) => {
    const contactExport = await ContactExportService.prepare(projectId, selector, {batchSize});
    let csv = '';
    for await (const chunk of contactExport.lines()) {
      csv += chunk;
    }
    return {csv, rows: contactExport.rows, records: parseImportCsv(csv)};
  };

  const all: BulkContactActionSelector = {mode: 'query', filter: {}};

  it('writes every matching contact exactly once across batches, sorted by email', async () => {
    await seed(30);

    const {csv, rows, records} = await exportCsv(all);

    expect(
      csv.startsWith('\uFEFFemail,subscribed,status,createdAt,updatedAt,segments,dynamicSegments,firstname\r\n'),
    ).toBe(true);
    expect(rows).toBe(30);
    expect(records.map(r => r.email)).toEqual(Array.from({length: 30}, (_, n) => emailOf(n)));
    expect(records[0]!.firstname).toBe('Name 0');
    expect(records[1]!.firstname).toBe('');
  });

  it('keeps going when the last contact of a batch is deleted mid-export', async () => {
    await seed(20);
    const contactExport = await ContactExportService.prepare(projectId, all, {batchSize: 7});
    const lines = contactExport.lines();

    let csv = (await lines.next()).value as string; // header
    csv += (await lines.next()).value as string; // first batch: c00..c06
    await prisma.contact.delete({where: {projectId_email: {projectId, email: emailOf(6)}}});
    for (let next = await lines.next(); !next.done; next = await lines.next()) {
      csv += next.value;
    }

    const emails = parseImportCsv(csv).map(r => r.email);
    expect(emails).toEqual(Array.from({length: 20}, (_, n) => emailOf(n)));
  });

  it('never exports contacts of another project, even by id', async () => {
    await seed(3);
    const {
      project: {id: otherProjectId},
    } = await factories.createUserWithProject();
    const stranger = await factories.createContact({projectId: otherProjectId, email: 'stranger@example.com'});
    const own = await prisma.contact.findFirstOrThrow({where: {projectId, email: emailOf(1)}});

    const byIds = await exportCsv({mode: 'ids', contactIds: [own.id, stranger.id]});
    expect(byIds.records.map(r => r.email)).toEqual([emailOf(1)]);

    const everything = await exportCsv(all);
    expect(everything.records.map(r => r.email)).not.toContain('stranger@example.com');
  });

  it('honours the status filter, the search and the unticked rows', async () => {
    await seed(4);
    const sleeping = await prisma.contact.findFirstOrThrow({where: {projectId, email: emailOf(1)}});
    await ContactService.snooze(sleeping.id, '1_year');
    const gone = await prisma.contact.findFirstOrThrow({where: {projectId, email: emailOf(2)}});
    await ContactService.unsubscribe(gone.id);

    const snoozed = await exportCsv({mode: 'query', filter: {status: 'snoozed'}});
    expect(snoozed.records.map(r => [r.email, r.subscribed, r.status])).toEqual([[emailOf(1), 'false', 'snoozed']]);

    const unsubscribed = await exportCsv({mode: 'query', filter: {status: 'unsubscribed'}});
    expect(unsubscribed.records.map(r => r.email)).toEqual([emailOf(2)]);

    const searched = await exportCsv({mode: 'query', filter: {search: 'C03'}});
    expect(searched.records.map(r => r.email)).toEqual([emailOf(3)]);

    const excluding = await exportCsv({mode: 'query', filter: {}, excludeIds: [sleeping.id]});
    expect(excluding.records.map(r => r.email)).toEqual([emailOf(0), emailOf(2), emailOf(3)]);
  });

  it('lists active static segments and live dynamic segments in separate columns', async () => {
    await seed(10);
    const club = await SegmentService.create(projectId, {name: 'Club', type: 'STATIC'});
    const vip = await SegmentService.create(projectId, {name: 'Alpha VIP', type: 'STATIC'});
    await SegmentService.addContacts(projectId, club.id, [emailOf(0), emailOf(8), emailOf(9)]);
    await SegmentService.addContacts(projectId, vip.id, [emailOf(8)]);
    await SegmentService.removeContacts(projectId, club.id, [emailOf(9)]);
    await factories.createSegment(projectId, {
      name: 'Has name',
      filters: [{field: 'data.firstname', operator: 'exists'}],
    });

    const {records} = await exportCsv(all, 3);
    const byEmail = new Map(records.map(r => [r.email, r]));

    expect(byEmail.get(emailOf(8))!.segments).toBe('Alpha VIP; Club');
    expect(byEmail.get(emailOf(0))!.segments).toBe('Club');
    expect(byEmail.get(emailOf(9))!.segments).toBe(''); // left the segment
    expect(byEmail.get(emailOf(0))!.dynamicsegments).toBe('Has name');
    expect(byEmail.get(emailOf(1))!.dynamicsegments).toBe('');
  });

  it('leaves out a dynamic segment whose filter cannot be built instead of failing', async () => {
    await seed(2);
    await prisma.segment.create({
      data: {projectId, name: 'Broken', type: 'DYNAMIC', condition: {nonsense: true}},
    });

    const {rows, records} = await exportCsv(all);
    expect(rows).toBe(2);
    expect(records.every(r => r.dynamicsegments === '')).toBe(true);
  });

  it('renames a custom field that clashes with a fixed column and re-imports to the same values', async () => {
    await factories.createContact({
      projectId,
      email: 'ana@example.com',
      data: {Status: 'gold', formula: '=1+1', phone: '+34 600 00 00 00', handle: '@ana', note: 'a, "quoted"\nline'},
    });

    const {csv, records} = await exportCsv(all);
    expect(csv.split('\r\n')[0]).toBe(
      '\uFEFFemail,subscribed,status,createdAt,updatedAt,segments,dynamicSegments,formula,handle,note,phone,data.Status',
    );

    const imported = splitImportRecord(records[0]!);
    expect(imported.email).toBe('ana@example.com');
    expect(imported.subscribed).toBe(true);
    expect(imported.segments).toBe('');
    expect(imported.data).toEqual({
      'data.status': 'gold',
      'formula': '=1+1',
      'handle': '@ana',
      'note': 'a, "quoted"\nline',
      'phone': '+34 600 00 00 00',
    });
  });
});
