import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

import {Controller, Delete, Get, Middleware, Patch, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import multer from 'multer';
import {ContactSchemas, resolveContactLanguage, UtilitySchemas} from '@plunk/shared';
import type {
  BulkContactActionJobData,
  BulkContactActionSelector,
  BulkContactRecordOperation,
  BulkSegmentOperation,
  ContactSubscriptionStatus,
} from '@plunk/types';
import {CONTACT_SUBSCRIPTION_STATUSES} from '@plunk/types';
import signale from 'signale';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {contactWriteRateLimit} from '../middleware/rateLimit.js';
import {HttpException} from '../exceptions/index.js';
import {ContactExportService} from '../services/ContactExportService.js';
import {ContactService} from '../services/ContactService.js';
import {QueueService} from '../services/QueueService.js';
import {BULK_SEGMENT_ACTION, SegmentMembershipService} from '../services/SegmentMembershipService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

// Configure multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max file size
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
});

/**
 * Read the `e` parameter the public list-management pages forward: the id of the
 * email the recipient acted from. Optional — mail sent before the parameter
 * existed, and hand-built links, carry no source.
 *
 * Unverified here; {@link ContactService.subscribe} / {@link ContactService.unsubscribe}
 * confirm the email belongs to the contact before recording it.
 */
function readSourceEmailId(req: Request): string | undefined {
  const value = req.query.e;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

@Controller('contacts')
export class Contacts {
  /**
   * GET /contacts
   * List all contacts for the authenticated project with cursor-based pagination
   */
  @Get('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async list(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const cursor = req.query.cursor as string | undefined;
    const search = req.query.search as string | undefined;

    // Optional status facet and column sort (?sort=email|createdAt&dir=asc|desc). Anything
    // else falls back to the default newest-first ordering with no status filter.
    //
    // Two spellings of the facet: `?status=subscribed|snoozed|unsubscribed` is the current
    // one, and `?subscribed=true|false` is kept working for callers written before snoozing
    // existed. `status` wins when both are present.
    const statusParam = req.query.status as ContactSubscriptionStatus | undefined;
    const status = statusParam && CONTACT_SUBSCRIPTION_STATUSES.includes(statusParam) ? statusParam : undefined;
    const subscribedParam = req.query.subscribed as string | undefined;
    const subscribed = subscribedParam === 'true' ? true : subscribedParam === 'false' ? false : undefined;
    const sortParam = req.query.sort as string | undefined;
    const sort = sortParam === 'email' || sortParam === 'createdAt' ? sortParam : undefined;
    const dirParam = req.query.dir as string | undefined;
    const dir = dirParam === 'asc' ? 'asc' : dirParam === 'desc' ? 'desc' : undefined;

    // Optional `?segmentId=`: only the contacts currently in that segment.
    const segmentIdParam = req.query.segmentId;
    if (segmentIdParam !== undefined && !UtilitySchemas.id.safeParse({id: segmentIdParam}).success) {
      throw new HttpException(400, 'segmentId must be a valid UUID');
    }
    const segmentId = segmentIdParam as string | undefined;

    const result = await ContactService.list(auth.projectId!, limit, cursor, search, {
      status,
      subscribed,
      segmentId,
      sort,
      dir,
    });

    return res.status(200).json(result);
  }

  /**
   * GET /contacts/fields
   * Get all available contact fields (both standard and custom fields from data JSON)
   * Returns field names with inferred types (string, number, boolean, date)
   */
  @Get('fields')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getAvailableFields(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    try {
      const fieldsWithTypes = await ContactService.getAvailableFields(auth.projectId!);

      return res.status(200).json({
        fields: fieldsWithTypes,
        count: fieldsWithTypes.length,
      });
    } catch (error) {
      signale.error('[CONTACTS] Failed to get available fields:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get available fields',
      });
    }
  }

  /**
   * GET /contacts/fields/:field/values
   * Get unique values for a contact field (for workflow conditions, segment filters, etc.)
   * Example: /contacts/fields/data.plan/values or /contacts/fields/subscribed/values
   */
  @Get('fields/:field/values')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getFieldValues(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const field = req.params.field;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 200);

    if (!field) {
      return res.status(400).json({error: 'Field is required'});
    }

    try {
      const values = await ContactService.getUniqueFieldValues(auth.projectId!, field, limit);

      return res.status(200).json({
        field,
        values,
        count: values.length,
        limit,
      });
    } catch (error) {
      signale.error('[CONTACTS] Failed to get field values:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get field values',
      });
    }
  }

  /**
   * GET /contacts/:id
   * Get a specific contact by ID
   */
  @Get(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async get(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).json({error: 'Contact ID is required'});
    }

    const contact = await ContactService.get(auth.projectId!, contactId);

    return res.status(200).json(contact);
  }

  /**
   * POST /contacts
   * Create or update a contact (upsert)
   */
  @Post('')
  @Middleware([requireAuth, requireEmailVerified, contactWriteRateLimit])
  @CatchAsync
  public async create(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {email, data, subscribed} = req.body;

    if (!email) {
      return res.status(400).json({error: 'Email is required'});
    }

    // Check if contact exists before upserting
    const existingContact = await ContactService.findByEmail(auth.projectId!, email);
    const isUpdate = !!existingContact;

    const contact = await ContactService.upsert(auth.projectId!, email, data, subscribed);

    return res.status(isUpdate ? 200 : 201).json({
      ...contact,
      _meta: {
        isNew: !isUpdate,
        isUpdate,
      },
    });
  }

  /**
   * PATCH /contacts/:id
   * Update a contact
   */
  @Patch(':id')
  @Middleware([requireAuth, requireEmailVerified, contactWriteRateLimit])
  @CatchAsync
  public async update(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const contactId = req.params.id;
    const {email, data, subscribed} = req.body;

    if (!contactId) {
      return res.status(400).json({error: 'Contact ID is required'});
    }

    const contact = await ContactService.update(auth.projectId!, contactId, {email, data, subscribed});

    return res.status(200).json(contact);
  }

  /**
   * DELETE /contacts/:id
   * Delete a contact
   */
  @Delete(':id')
  @Middleware([requireAuth, requireEmailVerified, contactWriteRateLimit])
  @CatchAsync
  public async delete(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).json({error: 'Contact ID is required'});
    }

    await ContactService.delete(auth.projectId!, contactId);

    return res.status(204).send();
  }

  /**
   * GET /contacts/public/:id
   * PUBLIC: Get contact information (no auth required)
   */
  @Get('public/:id')
  @CatchAsync
  public async getPublic(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).json({error: 'Contact ID is required'});
    }

    const contact = await ContactService.getById(contactId);

    // Fetch project to get language preference and the sender name the pages print
    const project = await ContactService.getProjectByContactId(contactId);

    // A contact always belongs to a project, so this only happens if the contact was deleted
    // between the two lookups. Report it as gone rather than rendering a sentence with an empty
    // sender ("emails from  at ...").
    if (!project) {
      throw new HttpException(404, 'Contact not found');
    }

    // The contact's language, chosen as for the footer that links here (their locale, else the project's)
    const locale =
      contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)
        ? (contact.data as Record<string, unknown>).locale
        : undefined;

    return res.status(200).json({
      id: contact.id,
      email: contact.email,
      subscribed: contact.subscribed,
      // Lets the snooze and manage pages tell a paused contact from a permanently
      // unsubscribed one -- both are `subscribed: false`.
      snoozedUntil: contact.snoozedUntil,
      // Names the sender inside the hosted pages' copy, so a recipient can see who they are
      // opting out of before they act. Already printed in the footer of every marketing email
      // this contact received, so it discloses nothing the link holder has not seen.
      projectName: project.name,
      language: resolveContactLanguage(locale, project.language),
    });
  }

  /**
   * POST /contacts/public/:id/subscribe
   * PUBLIC: Subscribe a contact (no auth required)
   */
  @Post('public/:id/subscribe')
  @CatchAsync
  public async subscribePublic(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).json({error: 'Contact ID is required'});
    }

    const contact = await ContactService.subscribe(contactId, {emailId: readSourceEmailId(req)});

    return res.status(200).json({
      id: contact.id,
      email: contact.email,
      subscribed: contact.subscribed,
      snoozedUntil: contact.snoozedUntil,
    });
  }

  /**
   * POST /contacts/public/:id/unsubscribe
   * PUBLIC: Unsubscribe a contact (no auth required)
   */
  @Post('public/:id/unsubscribe')
  @CatchAsync
  public async unsubscribePublic(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).json({error: 'Contact ID is required'});
    }

    const contact = await ContactService.unsubscribe(contactId, {emailId: readSourceEmailId(req)});

    return res.status(200).json({
      id: contact.id,
      email: contact.email,
      subscribed: contact.subscribed,
      snoozedUntil: contact.snoozedUntil,
    });
  }

  /**
   * POST /contacts/public/:id/snooze
   * PUBLIC: Snooze a contact -- unsubscribe them until a date, then resubscribe automatically
   * (no auth required).
   *
   * Offered alongside unsubscribe on the hosted pages so a recipient who only wants a break
   * has something to choose other than leaving for good or reporting the mail as spam. The
   * suppression is real for the whole window: a snoozed contact is `subscribed: false` and is
   * filtered out by every send path.
   */
  @Post('public/:id/snooze')
  @CatchAsync
  public async snoozePublic(req: Request, res: Response, _next: NextFunction) {
    const contactId = req.params.id;

    if (!contactId) {
      return res.status(400).json({error: 'Contact ID is required'});
    }

    const body = ContactSchemas.snooze.safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({error: 'A valid snooze duration is required'});
    }

    const contact = await ContactService.snooze(contactId, body.data.duration, {
      emailId: readSourceEmailId(req),
    });

    return res.status(200).json({
      id: contact.id,
      email: contact.email,
      subscribed: contact.subscribed,
      snoozedUntil: contact.snoozedUntil,
    });
  }

  /**
   * POST /contacts/lookup
   * Bulk-check which emails already exist in the project (max 500)
   */
  @Post('lookup')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async lookup(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {emails} = req.body as {emails: string[]};

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({error: 'emails must be a non-empty array'});
    }

    if (emails.length > 500) {
      return res.status(400).json({error: 'Maximum 500 emails per lookup'});
    }

    const result = await ContactService.lookup(auth.projectId!, emails);

    return res.status(200).json(result);
  }

  /**
   * POST /contacts/import
   * Import contacts from CSV file
   */
  @Post('import')
  @Middleware([requireAuth, requireEmailVerified, upload.single('file')])
  @CatchAsync
  public async importCsv(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    if (!req.file) {
      return res.status(400).json({error: 'CSV file is required'});
    }

    try {
      // Convert file buffer to base64 for storage in queue
      const csvData = req.file.buffer.toString('base64');
      const filename = req.file.originalname;

      // Queue import job
      const job = await QueueService.queueImport(auth.projectId!, csvData, filename);

      return res.status(202).json({
        message: 'Import queued successfully',
        jobId: job.id,
      });
    } catch (error) {
      signale.error('[CONTACTS] Failed to queue import:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to queue import',
      });
    }
  }

  /**
   * POST /contacts/export
   * Stream the selected contacts as CSV. Takes the same selector as the bulk actions: explicit
   * ids, or "all matching" the list filters minus unticked rows.
   */
  @Post('export')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async exportCsv(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const parsed = ContactSchemas.bulkAction.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpException(400, parsed.error.errors[0]?.message ?? 'Invalid export selector');
    }

    const selector: BulkContactActionSelector = parsed.data;

    // Anything that fails here still gets a JSON error: no CSV byte has been sent yet.
    const contactExport = await ContactExportService.prepare(auth.projectId!, selector);

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.setHeader('Cache-Control', 'no-store');
    // The image's nginx buffers proxied responses by default; stream straight through instead.
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      // pipeline handles backpressure, and closes the generator if the client goes away.
      await pipeline(Readable.from(contactExport.lines()), res);
      signale.info(`[CONTACTS] Exported ${contactExport.rows} contacts`, {
        projectId: auth.projectId,
        mode: selector.mode,
      });
    } catch (error) {
      // The CSV has already started, so there is no JSON error to send: pipeline has destroyed
      // the response, which the client sees as a failed download rather than a short file.
      signale.error(`[CONTACTS] Export stopped after ${contactExport.rows} contacts:`, error);
    }
  }

  /**
   * GET /contacts/import/:jobId
   * Get import job status
   */
  @Get('import/:jobId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getImportStatus(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const jobId = req.params.jobId;

    if (!jobId) {
      return res.status(400).json({error: 'Job ID is required'});
    }

    try {
      const status = await QueueService.getImportJobStatus(jobId, auth.projectId!);

      if (!status) {
        return res.status(404).json({error: 'Import job not found'});
      }

      return res.status(200).json(status);
    } catch (error) {
      signale.error('[CONTACTS] Failed to get import status:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get import status',
      });
    }
  }

  /**
   * GET /contacts/fields/:field/usage
   * Check if a field is used in segments/campaigns and get usage statistics
   * Returns information about where the field is used and whether it can be safely deleted
   */
  @Get('fields/:field/usage')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getFieldUsage(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const field = req.params.field;

    if (!field) {
      return res.status(400).json({error: 'Field is required'});
    }

    try {
      const usage = await ContactService.getFieldUsage(auth.projectId!, field);
      return res.status(200).json(usage);
    } catch (error) {
      signale.error('[CONTACTS] Failed to get field usage:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get field usage',
      });
    }
  }

  /**
   * DELETE /contacts/fields/:field
   * Delete a custom field from all contacts
   * Only works if the field is not used in any segments or campaigns
   */
  @Delete('fields/:field')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async deleteField(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const field = req.params.field;

    if (!field) {
      return res.status(400).json({error: 'Field is required'});
    }

    try {
      const result = await ContactService.deleteField(auth.projectId!, field);
      return res.status(200).json(result);
    } catch (error) {
      signale.error('[CONTACTS] Failed to delete field:', error);
      return res.status(error instanceof Error && error.message.includes('Cannot delete') ? 400 : 500).json({
        error: error instanceof Error ? error.message : 'Failed to delete field',
      });
    }
  }

  /**
   * POST /contacts/bulk-subscribe
   * Queue bulk subscribe operation
   */
  @Post('bulk-subscribe')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async bulkSubscribe(req: Request, res: Response, _next: NextFunction) {
    return queueBulkAction(req, res, 'subscribe');
  }

  /**
   * POST /contacts/bulk-unsubscribe
   * Queue bulk unsubscribe operation
   */
  @Post('bulk-unsubscribe')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async bulkUnsubscribe(req: Request, res: Response, _next: NextFunction) {
    return queueBulkAction(req, res, 'unsubscribe');
  }

  /**
   * POST /contacts/bulk-delete
   * Queue bulk delete operation
   */
  @Post('bulk-delete')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async bulkDelete(req: Request, res: Response, _next: NextFunction) {
    return queueBulkAction(req, res, 'delete');
  }

  /**
   * POST /contacts/bulk-add-to-segment
   * Queue adding contacts to a static segment. Contacts already in it re-enter it.
   */
  @Post('bulk-add-to-segment')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async bulkAddToSegment(req: Request, res: Response, _next: NextFunction) {
    return queueBulkSegmentAction(req, res, 'addToSegment');
  }

  /**
   * POST /contacts/bulk-remove-from-segment
   * Queue removing contacts from a static segment
   */
  @Post('bulk-remove-from-segment')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async bulkRemoveFromSegment(req: Request, res: Response, _next: NextFunction) {
    return queueBulkSegmentAction(req, res, 'removeFromSegment');
  }

  /**
   * GET /contacts/bulk/:jobId
   * Get bulk action job status
   */
  @Get('bulk/:jobId')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getBulkActionStatus(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const jobId = req.params.jobId;

    if (!jobId) {
      return res.status(400).json({error: 'Job ID is required'});
    }

    try {
      const status = await QueueService.getBulkActionJobStatus(jobId, auth.projectId!);

      if (!status) {
        return res.status(404).json({error: 'Bulk action job not found'});
      }

      return res.status(200).json(status);
    } catch (error) {
      signale.error('[CONTACTS] Failed to get bulk action status:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get bulk action status',
      });
    }
  }
}

/**
 * The selector part of a parsed bulk payload, without any other fields it carried. Repeated ids
 * are dropped: a contact listed twice would otherwise enter a segment twice.
 */
function toSelector(data: BulkContactActionSelector): BulkContactActionSelector {
  return data.mode === 'ids'
    ? {mode: 'ids', contactIds: [...new Set(data.contactIds)]}
    : {mode: 'query', filter: data.filter, excludeIds: data.excludeIds};
}

async function queueBulkAction(req: Request, res: Response, operation: BulkContactRecordOperation) {
  const parsed = ContactSchemas.bulkAction.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.errors[0]?.message ?? 'Invalid bulk action payload',
    });
  }

  return queueBulkJob(res, {projectId: res.locals.auth.projectId!, operation, selector: toSelector(parsed.data)});
}

async function queueBulkSegmentAction(req: Request, res: Response, operation: BulkSegmentOperation) {
  const projectId = res.locals.auth.projectId!;

  const parsed = ContactSchemas.bulkSegmentAction.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    throw new HttpException(
      400,
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid bulk action payload',
    );
  }

  // Reject a missing or dynamic segment now rather than in a job the user only sees fail later
  const {targetSegmentId} = parsed.data;
  await SegmentMembershipService.getStaticSegment(projectId, targetSegmentId, BULK_SEGMENT_ACTION[operation]);

  return queueBulkJob(res, {projectId, operation, targetSegmentId, selector: toSelector(parsed.data)});
}

async function queueBulkJob(res: Response, data: BulkContactActionJobData) {
  try {
    const job = await QueueService.queueBulkContactAction(data);
    return res.status(202).json({
      message: `Bulk ${data.operation} queued successfully`,
      jobId: job.id,
    });
  } catch (error) {
    signale.error(`[CONTACTS] Failed to queue bulk ${data.operation}:`, error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : `Failed to queue bulk ${data.operation}`,
    });
  }
}
