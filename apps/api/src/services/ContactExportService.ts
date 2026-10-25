import type {Prisma} from '@plunk/db';
import type {BulkContactActionSelector, FilterCondition} from '@plunk/types';
import {contactStatus, fromPrismaJson} from '@plunk/types';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {csvRow} from '../utils/csv.js';
import {ContactService} from './ContactService.js';
import {SegmentService} from './SegmentService.js';

/** Fixed columns, in order. Custom `data` fields follow them, sorted by key. */
const FIXED_COLUMNS = ['email', 'subscribed', 'status', 'createdAt', 'updatedAt', 'segments', 'dynamicSegments'];

/** Byte order mark, so spreadsheets read the file as UTF-8. The contact import strips it. */
const BOM = '\uFEFF';

const contactSelect = {
  id: true,
  email: true,
  subscribed: true,
  snoozedUntil: true,
  createdAt: true,
  updatedAt: true,
  data: true,
} satisfies Prisma.ContactSelect;

type ExportedContact = Prisma.ContactGetPayload<{select: typeof contactSelect}>;

interface DynamicSegment {
  id: string;
  name: string;
  where: Prisma.ContactWhereInput;
}

export interface ContactExport {
  /** CSV text, in chunks: the header first, then one chunk per batch of contacts. */
  lines(): AsyncGenerator<string>;
  /** Contacts written so far. */
  readonly rows: number;
}

/**
 * Streams a project's contacts as CSV in one pass.
 *
 * Contacts are read in batches keyed on email, which walks the `(projectId, email)` unique
 * index and, unlike Prisma's `cursor:`, does not need the previous batch's last row to still
 * exist -- a contact deleted mid-export is simply not written. Each batch costs one query for
 * static segment memberships and one per dynamic segment, never one per contact.
 */
export class ContactExportService {
  /**
   * Everything that can fail before the first byte is sent: the column set and the dynamic
   * segment filters. The caller can still answer with a JSON error if this throws.
   */
  public static async prepare(
    projectId: string,
    selector: BulkContactActionSelector,
    {batchSize = 500}: {batchSize?: number} = {},
  ): Promise<ContactExport> {
    const where: Prisma.ContactWhereInput =
      selector.mode === 'ids'
        ? {projectId, id: {in: selector.contactIds}}
        : ContactService.buildQueryWhere(projectId, selector);

    const customKeys = await ContactService.getCustomFieldKeys(projectId);
    const fixed = new Set(FIXED_COLUMNS.map(column => column.toLowerCase()));
    // A custom field named like a fixed column would make two identical headers.
    const customHeaders = customKeys.map(key => (fixed.has(key.toLowerCase()) ? `data.${key}` : key));

    const dynamicSegments = await this.loadDynamicSegments(projectId);

    let rows = 0;

    return {
      get rows() {
        return rows;
      },
      async *lines() {
        yield BOM + csvRow([...FIXED_COLUMNS, ...customHeaders]);

        let lastEmail: string | undefined;
        for (;;) {
          const contacts = await prisma.contact.findMany({
            where: lastEmail ? {AND: [where, {email: {gt: lastEmail}}]} : where,
            orderBy: {email: 'asc'},
            take: batchSize,
            select: contactSelect,
          });
          if (contacts.length === 0) {
            return;
          }

          const ids = contacts.map(contact => contact.id);
          const staticNames = await ContactExportService.staticSegmentNames(projectId, ids);
          const dynamicNames = await ContactExportService.dynamicSegmentNames(projectId, ids, dynamicSegments);

          let chunk = '';
          for (const contact of contacts) {
            chunk += csvRow(ContactExportService.rowFor(contact, customKeys, staticNames, dynamicNames));
          }
          yield chunk;
          // Counted once the stream has taken the batch, so an interrupted export logs what was sent.
          rows += contacts.length;

          if (contacts.length < batchSize) {
            return;
          }
          lastEmail = contacts[contacts.length - 1]!.email;
        }
      },
    };
  }

  private static rowFor(
    contact: ExportedContact,
    customKeys: string[],
    staticNames: Map<string, string[]>,
    dynamicNames: Map<string, string[]>,
  ): unknown[] {
    const data =
      contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)
        ? (contact.data as Record<string, unknown>)
        : {};

    return [
      contact.email,
      contact.subscribed,
      contactStatus(contact),
      contact.createdAt,
      contact.updatedAt,
      (staticNames.get(contact.id) ?? []).join('; '),
      (dynamicNames.get(contact.id) ?? []).join('; '),
      ...customKeys.map(key => data[key]),
    ];
  }

  /** Active static memberships of a batch, as sorted segment names per contact. */
  private static async staticSegmentNames(projectId: string, contactIds: string[]): Promise<Map<string, string[]>> {
    const memberships = await prisma.segmentMembership.findMany({
      where: {contactId: {in: contactIds}, exitedAt: null, segment: {projectId, type: 'STATIC'}},
      select: {contactId: true, segment: {select: {name: true}}},
    });

    const names = new Map<string, string[]>();
    for (const membership of memberships) {
      names.set(membership.contactId, [...(names.get(membership.contactId) ?? []), membership.segment.name]);
    }
    return sortNames(names);
  }

  /**
   * The project's dynamic segments with their filters built once. Membership is evaluated live
   * from the filter -- the same rule the member counts use -- so it does not depend on whether
   * the segment tracks membership. A filter that cannot be built or run (a malformed condition,
   * a reference to a deleted segment) leaves that segment out of the export rather than failing it.
   */
  private static async loadDynamicSegments(projectId: string): Promise<DynamicSegment[]> {
    const segments = await prisma.segment.findMany({
      where: {projectId, type: 'DYNAMIC'},
      select: {id: true, name: true, condition: true},
    });

    const usable: DynamicSegment[] = [];
    for (const segment of segments) {
      try {
        const condition = fromPrismaJson<FilterCondition>(segment.condition);
        const where = await SegmentService.buildConditionClause(condition);
        await prisma.contact.findFirst({where: {AND: [{projectId}, where]}, select: {id: true}});
        usable.push({id: segment.id, name: segment.name, where});
      } catch (error) {
        signale.warn(`[CONTACT-EXPORT] Leaving dynamic segment ${segment.id} out of the export:`, error);
      }
    }
    return usable;
  }

  private static async dynamicSegmentNames(
    projectId: string,
    contactIds: string[],
    segments: DynamicSegment[],
  ): Promise<Map<string, string[]>> {
    const names = new Map<string, string[]>();

    // Iterate over a copy: a segment whose filter fails mid-export is dropped for the rest of it.
    for (const segment of [...segments]) {
      try {
        const members = await prisma.contact.findMany({
          where: {AND: [{projectId}, segment.where, {id: {in: contactIds}}]},
          select: {id: true},
        });
        for (const member of members) {
          names.set(member.id, [...(names.get(member.id) ?? []), segment.name]);
        }
      } catch (error) {
        signale.warn(`[CONTACT-EXPORT] Dropping dynamic segment ${segment.id} from the rest of the export:`, error);
        segments.splice(segments.indexOf(segment), 1);
      }
    }
    return sortNames(names);
  }
}

/** Sort each contact's segment names, the same way for static and dynamic segments. */
function sortNames(names: Map<string, string[]>): Map<string, string[]> {
  for (const list of names.values()) {
    list.sort((a, b) => a.localeCompare(b));
  }
  return names;
}
