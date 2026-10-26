import type {Prisma} from '@plunk/db';
import type {BulkContactActionSelector, SegmentRef} from '@plunk/types';
import {contactStatus} from '@plunk/types';

import {prisma} from '../database/prisma.js';
import {csvRow} from '../utils/csv.js';
import {ContactSegmentsService} from './ContactSegmentsService.js';
import {ContactService} from './ContactService.js';

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

    const dynamicSegments = await ContactSegmentsService.loadDynamicSegments(projectId);

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
          const staticSegments = await ContactSegmentsService.staticSegmentsOf(projectId, ids);
          const dynamicMatches = await ContactSegmentsService.dynamicSegmentsOf(projectId, ids, dynamicSegments);

          let chunk = '';
          for (const contact of contacts) {
            chunk += csvRow(ContactExportService.rowFor(contact, customKeys, staticSegments, dynamicMatches));
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
    staticSegments: Map<string, SegmentRef[]>,
    dynamicSegments: Map<string, SegmentRef[]>,
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
      namesOf(staticSegments.get(contact.id)),
      namesOf(dynamicSegments.get(contact.id)),
      ...customKeys.map(key => data[key]),
    ];
  }
}

/** A contact's segments as the cell lists them: names, already sorted, joined by `; `. */
function namesOf(segments: SegmentRef[] = []): string {
  return segments.map(segment => segment.name).join('; ');
}
