import {Prisma, type Segment} from '@plunk/db';
import {SegmentSchemas} from '@plunk/shared';
import {type ContactImportResult, SEGMENT_IMPORT_ERROR_ROW} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {NtfyService} from './NtfyService.js';
import {SegmentService} from './SegmentService.js';

/** Most static segments one import may create, so a mislabelled column cannot spawn hundreds. */
export const MAX_SEGMENTS_CREATED_PER_IMPORT = 25;
/** Most segment names one cell may list; the rest of that cell is ignored and reported. */
export const MAX_SEGMENTS_PER_CELL = 100;

type KnownSegment = Pick<Segment, 'id' | 'name' | 'type'>;

/** How segment names are compared: Unicode-normalised, trimmed and case-insensitive. */
export function segmentKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/**
 * Split a `segments` cell into names. Names are separated by `;`, but a segment's own name may
 * contain `;` too, so runs of pieces that spell an existing name are kept together (longest
 * first) before the rest is split. `maxPieces` is the most pieces any existing name spans, which
 * bounds the search: without it a cell of thousands of `;` would take minutes to split.
 */
export function splitSegmentCell(cell: string, isExistingName: (key: string) => boolean, maxPieces = 1): string[] {
  const pieces = cell.split(';');
  const names: string[] = [];

  for (let start = 0; start < pieces.length; ) {
    let end = start + 1;
    for (let candidate = Math.min(pieces.length, start + maxPieces); candidate > start + 1; candidate--) {
      if (isExistingName(segmentKey(pieces.slice(start, candidate).join(';')))) {
        end = candidate;
        break;
      }
    }
    names.push(pieces.slice(start, end).join(';').trim());
    start = end;
  }

  const seen = new Set<string>();
  return names.filter(name => {
    const key = segmentKey(name);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export interface ImportedRow {
  contactId: string;
  email: string;
  /** Raw `segments` cell, if the CSV has that column. */
  segments?: string;
}

/**
 * Assigns imported contacts to the static segments their `segments` cell names.
 *
 * Only ever adds: a blank cell or a missing column leaves memberships alone, and nobody is taken
 * out of a segment their row does not list. A name with no segment behind it creates a static
 * segment -- lazily, once a row that names it has been imported, so failed rows leave no empty
 * segments behind. Problems are reported once per name, not once per row.
 */
export class ImportSegmentResolver {
  private readonly segmentsByKey = new Map<string, KnownSegment[]>();
  /** Most `;`-separated pieces any known name spans (see `splitSegmentCell`). */
  private maxPieces = 1;
  /** Names that can never be assigned in this import (dynamic, ambiguous, invalid, over the cap). */
  private readonly unusable = new Set<string>();
  private readonly errorsByKey = new Map<string, string>();
  private cellCapExceeded = false;
  private readonly created: string[] = [];
  private assigned = 0;

  private constructor(private readonly projectId: string) {}

  public static async load(projectId: string): Promise<ImportSegmentResolver> {
    const resolver = new ImportSegmentResolver(projectId);
    const segments = await prisma.segment.findMany({
      where: {projectId},
      select: {id: true, name: true, type: true},
      orderBy: {createdAt: 'asc'},
    });
    for (const segment of segments) {
      resolver.remember(segment);
    }
    return resolver;
  }

  public get segmentsCreated(): string[] {
    return [...this.created];
  }

  public get segmentAssignments(): number {
    return this.assigned;
  }

  /** One entry per segment name that could not be assigned, in the shape of import errors. */
  public get errors(): ContactImportResult['errors'] {
    const messages = [...this.errorsByKey.values()];
    if (this.cellCapExceeded) {
      messages.push(`Segment cells may list at most ${MAX_SEGMENTS_PER_CELL} names; the rest were ignored`);
    }
    return messages.map(error => ({row: SEGMENT_IMPORT_ERROR_ROW, email: '', error}));
  }

  /** Assign one batch of successfully imported rows. */
  public async assignBatch(rows: ImportedRow[]): Promise<void> {
    const rowsByName = new Map<string, {name: string; rows: ImportedRow[]}>();
    for (const row of rows) {
      if (!row.segments) {
        continue;
      }
      const names = splitSegmentCell(row.segments, key => this.segmentsByKey.has(key), this.maxPieces);
      if (names.length > MAX_SEGMENTS_PER_CELL) {
        this.cellCapExceeded = true;
      }
      for (const name of names.slice(0, MAX_SEGMENTS_PER_CELL)) {
        const key = segmentKey(name);
        const entry = rowsByName.get(key) ?? {name, rows: []};
        entry.rows.push(row);
        rowsByName.set(key, entry);
      }
    }

    for (const [key, {name, rows: named}] of rowsByName) {
      if (this.unusable.has(key)) {
        continue;
      }
      try {
        const segmentId = await this.resolve(key, name);
        if (segmentId) {
          await this.addMissing(segmentId, named);
        }
      } catch (error) {
        // Likely transient (a busy connection pool, a timeout): report it, but let later batches
        // try this segment again rather than skipping it for the rest of the import.
        signale.error(`[IMPORT-SEGMENTS] Failed to assign segment "${name}":`, error);
        this.errorsByKey.set(
          key,
          `Segment "${name}" could not be assigned to every contact (${error instanceof Error ? error.message : 'unknown error'})`,
        );
      }
    }
  }

  /** The static segment a name points at, creating it if nothing has that name. */
  private async resolve(key: string, name: string): Promise<string | null> {
    const known = this.pickKnown(key, name);
    if (known !== undefined) {
      return known;
    }
    if (!SegmentSchemas.create.shape.name.safeParse(name).success) {
      return this.block(key, name, 'is not a valid segment name (1 to 100 characters)');
    }
    if (this.created.length >= MAX_SEGMENTS_CREATED_PER_IMPORT) {
      return this.block(
        key,
        name,
        `was not created: an import can create at most ${MAX_SEGMENTS_CREATED_PER_IMPORT} segments`,
      );
    }

    return this.createStatic(key, name);
  }

  /**
   * Create a static segment, unless another import (or someone in the dashboard) created one with
   * that name since this import started. The advisory lock serialises importers creating the same
   * name, and the row is written inside the same short transaction; the notification a segment
   * created in the dashboard sends goes out after the commit, so a slow notifier cannot time the
   * transaction out.
   */
  private async createStatic(key: string, name: string): Promise<string | null> {
    const created = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`segment-import:${this.projectId}:${key}`}))`;

      const sameName = (
        await tx.segment.findMany({
          where: {projectId: this.projectId},
          select: {id: true, name: true, type: true},
          orderBy: {createdAt: 'asc'},
        })
      ).filter(segment => segmentKey(segment.name) === key);
      if (sameName.length > 0) {
        return {kind: 'existing' as const, segments: sameName};
      }

      return {
        kind: 'created' as const,
        segment: await tx.segment.create({
          data: {projectId: this.projectId, name, type: 'STATIC', condition: Prisma.JsonNull},
          select: {id: true, name: true, type: true, project: {select: {name: true}}},
        }),
      };
    });

    if (created.kind === 'existing') {
      created.segments.forEach(segment => this.remember(segment));
      return this.pickKnown(key, name) ?? null;
    }

    const {segment} = created;
    this.remember(segment);
    this.created.push(segment.name);
    await NtfyService.notifySegmentCreated(segment.name, segment.project.name, this.projectId);
    return segment.id;
  }

  /**
   * The segment an already-known name points at: its id, `null` when the name cannot be used
   * (the failure is recorded), or `undefined` when no segment has that name.
   */
  private pickKnown(key: string, name: string): string | null | undefined {
    const known = this.segmentsByKey.get(key) ?? [];
    if (known.length === 0) {
      return undefined;
    }

    // A static segment wins over a dynamic one of the same name: only static ones take members.
    const statics = known.filter(segment => segment.type === 'STATIC');
    if (statics.length === 1) {
      return statics[0]!.id;
    }
    if (statics.length > 1) {
      return this.block(key, name, `matches ${statics.length} static segments with the same name; rename one`);
    }
    return this.block(key, name, 'is a dynamic segment; contacts join it through its filter');
  }

  /** Add the rows' contacts that are not already active members. */
  private async addMissing(segmentId: string, rows: ImportedRow[]): Promise<void> {
    const active = await prisma.segmentMembership.findMany({
      where: {segmentId, contactId: {in: rows.map(row => row.contactId)}, exitedAt: null},
      select: {contactId: true},
    });
    const activeIds = new Set(active.map(membership => membership.contactId));
    const emails = rows.filter(row => !activeIds.has(row.contactId)).map(row => row.email);
    if (emails.length === 0) {
      return;
    }

    const {added} = await SegmentService.addContacts(this.projectId, segmentId, emails);
    this.assigned += added;
  }

  private remember(segment: KnownSegment): void {
    const key = segmentKey(segment.name);
    const known = this.segmentsByKey.get(key) ?? [];
    if (!known.some(existing => existing.id === segment.id)) {
      this.segmentsByKey.set(key, [...known, segment]);
      this.maxPieces = Math.max(this.maxPieces, key.split(';').length);
    }
  }

  /** Record why a name cannot be used and skip it for the rest of the import. */
  private block(key: string, name: string, reason: string): null {
    this.unusable.add(key);
    this.errorsByKey.set(key, `Segment "${name}" ${reason}`);
    return null;
  }
}
