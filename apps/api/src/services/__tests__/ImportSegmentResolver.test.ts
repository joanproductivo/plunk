import {beforeEach, describe, expect, it, vi} from 'vitest';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {
  type ImportedRow,
  ImportSegmentResolver,
  MAX_SEGMENTS_CREATED_PER_IMPORT,
  MAX_SEGMENTS_PER_CELL,
  segmentKey,
  splitSegmentCell,
} from '../ImportSegmentResolver.js';
import {EventService} from '../EventService.js';
import {QueueService} from '../QueueService.js';
import {SegmentService} from '../SegmentService.js';

/**
 * The `segments` column of a CSV import: it only ever adds contacts to static segments, and
 * creates a static segment for a name nothing has yet.
 */
describe('ImportSegmentResolver', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    ({
      project: {id: projectId},
    } = await factories.createUserWithProject());
  });

  const rowFor = async (email: string, segments?: string): Promise<ImportedRow> => {
    const contact = await factories.createContact({projectId, email});
    return {contactId: contact.id, segments};
  };

  const activeMembers = async (segmentId: string) =>
    (
      await prisma.segmentMembership.findMany({
        where: {segmentId, exitedAt: null},
        include: {contact: {select: {email: true}}},
      })
    )
      .map(m => m.contact.email)
      .sort();

  const assign = async (rows: ImportedRow[]) => {
    const resolver = await ImportSegmentResolver.load(projectId);
    await resolver.assignBatch(rows);
    return resolver;
  };

  describe('splitSegmentCell', () => {
    it('splits on semicolons, trims and drops blanks and repeats', () => {
      expect(splitSegmentCell(' Club ;; VIP;club ', () => false)).toEqual(['Club', 'VIP']);
      expect(splitSegmentCell('', () => false)).toEqual([]);
    });

    it('keeps an existing name that contains a semicolon in one piece', () => {
      const known = new Set([segmentKey('A; B')]);
      expect(splitSegmentCell('A; B; C', key => known.has(key), {';': 2})).toEqual(['A; B', 'C']);
    });

    it('splits a cell of thousands of separators quickly', () => {
      const cell = Array.from({length: 5000}, (_, n) => `S${n}`).join(';');
      const started = Date.now();

      expect(splitSegmentCell(cell, () => false, {';': 3})).toHaveLength(5000);
      expect(splitSegmentCell(cell.replaceAll(';', ','), () => false, {',': 3})).toHaveLength(5000);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('splits a cell of thousands of commas quickly, whatever names with commas exist', () => {
      const cell = Array.from({length: 100_000}, () => 'a').join(',');
      const started = Date.now();

      expect(splitSegmentCell(cell, () => false, {',': 50})).toEqual(['a']);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('reads a cell from the contacts export on semicolons only', () => {
      expect(splitSegmentCell('Ventas, 2024', () => false, {}, false)).toEqual(['Ventas, 2024']);
      expect(splitSegmentCell('Club; Ventas, 2024', () => false, {}, false)).toEqual(['Club', 'Ventas, 2024']);
    });

    it('splits on commas when the cell has no semicolon, as Flodesk exports it', () => {
      expect(splitSegmentCell('Club, Ventas, Newsletter', () => false)).toEqual(['Club', 'Ventas', 'Newsletter']);
    });

    it('splits on semicolons only when the cell has one', () => {
      expect(splitSegmentCell('Otro; Ventas, 2024', () => false, {',': 2})).toEqual(['Otro', 'Ventas, 2024']);
    });

    it('keeps an existing name that contains a comma in one piece', () => {
      const known = new Set([segmentKey('Ventas, 2024')]);
      expect(splitSegmentCell('Club, Ventas, 2024, VIP', key => known.has(key), {',': 2})).toEqual([
        'Club',
        'Ventas, 2024',
        'VIP',
      ]);
      // Without the name in the project, the comma splits it (the cell has no `;`)
      expect(splitSegmentCell('Club, Ventas, 2024', () => false, {',': 2})).toEqual(['Club', 'Ventas', '2024']);
    });
  });

  it('adds contacts to an existing static segment, matching the name loosely', async () => {
    const club = await SegmentService.create(projectId, {name: 'Club VIP ', type: 'STATIC'});
    const decomposed = await SegmentService.create(projectId, {name: 'Café', type: 'STATIC'});

    const resolver = await assign([await rowFor('ana@example.com', 'club vip; Café')]);

    expect(await activeMembers(club.id)).toEqual(['ana@example.com']);
    expect(await activeMembers(decomposed.id)).toEqual(['ana@example.com']);
    expect(resolver.segmentsCreated).toEqual([]);
    expect(resolver.segmentAssignments).toBe(2);
    expect(resolver.errors).toEqual([]);
  });

  it('creates a static segment for a new name', async () => {
    const resolver = await assign([await rowFor('ana@example.com', 'Nuevo'), await rowFor('bo@example.com', 'nuevo')]);

    const created = await prisma.segment.findMany({where: {projectId}});
    expect(created.map(s => [s.name, s.type])).toEqual([['Nuevo', 'STATIC']]);
    expect(await activeMembers(created[0]!.id)).toEqual(['ana@example.com', 'bo@example.com']);
    expect(resolver.segmentsCreated).toEqual(['Nuevo']);
  });

  it('never takes anyone out of a segment', async () => {
    const club = await SegmentService.create(projectId, {name: 'Club', type: 'STATIC'});
    await SegmentService.addContacts(projectId, club.id, ['ana@example.com'], true);
    const ana = await prisma.contact.findFirstOrThrow({where: {projectId, email: 'ana@example.com'}});

    await assign([
      {contactId: ana.id, segments: ''},
      {contactId: ana.id, segments: 'Other'},
    ]);

    expect(await activeMembers(club.id)).toEqual(['ana@example.com']);
  });

  it('leaves existing members untouched on a re-import', async () => {
    const club = await SegmentService.create(projectId, {name: 'Club', type: 'STATIC'});
    const row = await rowFor('ana@example.com', 'Club');
    await assign([row]);
    const before = await prisma.segmentMembership.findFirstOrThrow({where: {segmentId: club.id}});

    const resolver = await assign([row]);

    const after = await prisma.segmentMembership.findFirstOrThrow({where: {segmentId: club.id}});
    expect(resolver.segmentAssignments).toBe(0);
    expect(after.enteredAt).toEqual(before.enteredAt);
  });

  it('fires no entry events, even for a segment that tracks membership', async () => {
    const club = await SegmentService.create(projectId, {name: 'Club', type: 'STATIC', trackMembership: true});
    const row = await rowFor('ana@example.com', 'Club');
    const trackEvents = vi.spyOn(EventService, 'trackEventsSequentially');
    const queueEvents = vi.spyOn(QueueService, 'queueSegmentMembershipEvents');

    expect((await assign([row])).segmentAssignments).toBe(1);
    expect((await assign([row])).segmentAssignments).toBe(0);
    await prisma.segmentMembership.updateMany({where: {segmentId: club.id}, data: {exitedAt: new Date()}});
    expect((await assign([row])).segmentAssignments).toBe(1);

    expect(await activeMembers(club.id)).toEqual(['ana@example.com']);
    expect(trackEvents).not.toHaveBeenCalled();
    expect(queueEvents).not.toHaveBeenCalled();
    trackEvents.mockRestore();
    queueEvents.mockRestore();
    expect(await prisma.event.count({where: {projectId, name: {startsWith: 'segment.'}}})).toBe(0);
  });

  it('re-adds a contact who had left the segment', async () => {
    const club = await SegmentService.create(projectId, {name: 'Club', type: 'STATIC'});
    const row = await rowFor('ana@example.com', 'Club');
    await assign([row]);
    await SegmentService.removeContacts(projectId, club.id, ['ana@example.com']);

    const resolver = await assign([row]);

    expect(await activeMembers(club.id)).toEqual(['ana@example.com']);
    expect(resolver.segmentAssignments).toBe(1);
  });

  it('reports a dynamic or ambiguous name once instead of assigning it', async () => {
    await factories.createSegment(projectId, {name: 'Engaged'});
    await SegmentService.create(projectId, {name: 'Twice', type: 'STATIC'});
    await SegmentService.create(projectId, {name: 'twice', type: 'STATIC'});

    const resolver = await assign([
      await rowFor('ana@example.com', 'Engaged; Twice'),
      await rowFor('bo@example.com', 'Engaged'),
    ]);

    expect(resolver.errors.map(e => e.error).sort()).toEqual([
      'Segment "Engaged" is a dynamic segment; contacts join it through its filter',
      'Segment "Twice" matches 2 static segments with the same name; rename one',
    ]);
    expect(resolver.errors.every(e => e.row === 0 && e.email === '')).toBe(true);
    expect(await prisma.segment.count({where: {projectId}})).toBe(3);
    expect(await prisma.segmentMembership.count({where: {contact: {projectId}}})).toBe(0);
  });

  it('prefers the static segment when a dynamic one has the same name', async () => {
    await factories.createSegment(projectId, {name: 'Club'});
    const club = await SegmentService.create(projectId, {name: 'Club', type: 'STATIC'});

    await assign([await rowFor('ana@example.com', 'Club')]);

    expect(await activeMembers(club.id)).toEqual(['ana@example.com']);
  });

  it('stops creating segments after the per-import cap', async () => {
    const names = Array.from({length: MAX_SEGMENTS_CREATED_PER_IMPORT + 1}, (_, n) => `S${n}`);

    const resolver = await assign([await rowFor('ana@example.com', names.join(';'))]);

    expect(resolver.segmentsCreated).toHaveLength(MAX_SEGMENTS_CREATED_PER_IMPORT);
    expect(resolver.errors).toHaveLength(1);
    expect(resolver.errors[0]!.error).toContain(`at most ${MAX_SEGMENTS_CREATED_PER_IMPORT} segments`);
  });

  it('assigns at most the per-cell cap of names and reports the rest once', async () => {
    const club = await SegmentService.create(projectId, {name: 'Club', type: 'STATIC'});
    const names = ['Club', ...Array.from({length: MAX_SEGMENTS_PER_CELL}, (_, n) => `Extra ${n}`)];

    const resolver = await assign([await rowFor('ana@example.com', names.join(';'))]);

    expect(await activeMembers(club.id)).toEqual(['ana@example.com']);
    expect(resolver.errors.map(e => e.error)).toContain(
      `Segment cells may list at most ${MAX_SEGMENTS_PER_CELL} names; the rest were ignored`,
    );
  });

  it('creates a single segment when two imports race for the same new name', async () => {
    const [first, second] = await Promise.all([
      ImportSegmentResolver.load(projectId),
      ImportSegmentResolver.load(projectId),
    ]);
    const ana = await rowFor('ana@example.com', 'Race');
    const bo = await rowFor('bo@example.com', 'Race');

    await Promise.all([first.assignBatch([ana]), second.assignBatch([bo])]);

    const segments = await prisma.segment.findMany({where: {projectId}});
    expect(segments).toHaveLength(1);
    expect(await activeMembers(segments[0]!.id)).toEqual(['ana@example.com', 'bo@example.com']);
  });

  it('keeps a name with a semicolon whole when it exists', async () => {
    const ab = await SegmentService.create(projectId, {name: 'A; B', type: 'STATIC'});

    const resolver = await assign([await rowFor('ana@example.com', 'A; B; C')]);

    expect(await activeMembers(ab.id)).toEqual(['ana@example.com']);
    expect(resolver.segmentsCreated).toEqual(['C']);
  });

  it('keeps an existing name with a comma whole in a comma-separated cell', async () => {
    const sales = await SegmentService.create(projectId, {name: 'Ventas, 2024', type: 'STATIC'});

    const resolver = await assign([await rowFor('ana@example.com', 'Club, Ventas, 2024')]);

    expect(await activeMembers(sales.id)).toEqual(['ana@example.com']);
    expect(resolver.segmentsCreated).toEqual(['Club']);
  });

  it('ignores segments of another project with the same name', async () => {
    const {
      project: {id: otherProjectId},
    } = await factories.createUserWithProject();
    const foreign = await SegmentService.create(otherProjectId, {name: 'Club', type: 'STATIC'});

    const resolver = await assign([await rowFor('ana@example.com', 'Club')]);

    expect(resolver.segmentsCreated).toEqual(['Club']);
    expect(await activeMembers(foreign.id)).toEqual([]);
  });
});
