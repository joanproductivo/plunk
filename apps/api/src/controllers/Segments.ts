import {Controller, Delete, Get, Middleware, Patch, Post} from '@overnightjs/core';
import {SegmentSchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';
import type {ZodError} from 'zod';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {contactWriteRateLimit} from '../middleware/rateLimit.js';
import {SegmentService} from '../services/SegmentService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/** The first validation problem of a members payload, with where it is (e.g. "emails.3: …") */
function membersPayloadError(error: ZodError): string {
  const issue = error.errors[0];
  if (!issue) return 'Invalid members payload';
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

@Controller('segments')
export class Segments {
  /**
   * GET /segments
   * List all segments for the authenticated project
   */
  @Get('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async list(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const segments = await SegmentService.list(auth.projectId!);

    return res.status(200).json(segments);
  }

  /**
   * GET /segments/:id
   * Get a specific segment by ID with member count
   */
  @Get(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async get(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    const segment = await SegmentService.get(auth.projectId!, segmentId);

    return res.status(200).json(segment);
  }

  /**
   * GET /segments/:id/contacts
   * Get contacts that match a segment's filters
   */
  @Get(':id/contacts')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getContacts(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    const result = await SegmentService.getContacts(auth.projectId!, segmentId, page, pageSize);

    return res.status(200).json(result);
  }

  /**
   * POST /segments
   * Create a new segment
   */
  @Post('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async create(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {name, description, type, condition, trackMembership} = req.body;

    if (!name) {
      return res.status(400).json({error: 'Name is required'});
    }

    const segmentType = type ?? 'DYNAMIC';

    if (segmentType === 'DYNAMIC' && (!condition || typeof condition !== 'object')) {
      return res.status(400).json({error: 'Condition is required and must be an object for DYNAMIC segments'});
    }

    const segment = await SegmentService.create(auth.projectId!, {
      name,
      description,
      type: segmentType,
      condition: segmentType === 'DYNAMIC' ? condition : undefined,
      trackMembership,
    });

    return res.status(201).json(segment);
  }

  /**
   * PATCH /segments/:id
   * Update a segment
   */
  @Patch(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async update(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;
    const {name, description, condition, trackMembership} = req.body;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    if (condition !== undefined && typeof condition !== 'object') {
      return res.status(400).json({error: 'Condition must be an object'});
    }

    const segment = await SegmentService.update(auth.projectId!, segmentId, {
      name,
      description,
      condition,
      trackMembership,
    });

    return res.status(200).json(segment);
  }

  /**
   * DELETE /segments/:id
   * Delete a segment
   */
  @Delete(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async delete(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    await SegmentService.delete(auth.projectId!, segmentId);

    return res.status(204).send();
  }

  /**
   * POST /segments/bulk-update
   * Apply a bulk operation to several segments. Only `{ids, delete: true}` exists: it deletes
   * every segment or, if any is missing or still in use, none (see SegmentService.bulkUpdate).
   */
  @Post('bulk-update')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async bulkUpdate(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    // Zod errors go to the global handler, which answers in the standard error envelope.
    const data = SegmentSchemas.bulkUpdate.parse(req.body);

    const result = await SegmentService.bulkUpdate(auth.projectId!, data);

    return res.status(200).json(result);
  }

  /**
   * POST /segments/:id/members
   * Add contacts to a static segment by email. Plunk Lite: `createMissing` creates the missing ones
   * unsubscribed; joining a segment never subscribes anyone.
   */
  @Post(':id/members')
  @Middleware([requireAuth, requireEmailVerified, contactWriteRateLimit])
  @CatchAsync
  public async addMembers(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    const parsed = SegmentSchemas.members.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: membersPayloadError(parsed.error)});
    }

    const {emails, createMissing} = parsed.data;
    const result = await SegmentService.addContacts(auth.projectId!, segmentId, emails, createMissing ?? false);

    return res.status(200).json(result);
  }

  /**
   * DELETE /segments/:id/members
   * Remove contacts from a static segment by email
   */
  @Delete(':id/members')
  @Middleware([requireAuth, requireEmailVerified, contactWriteRateLimit])
  @CatchAsync
  public async removeMembers(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    const parsed = SegmentSchemas.members.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({error: membersPayloadError(parsed.error)});
    }

    const result = await SegmentService.removeContacts(auth.projectId!, segmentId, parsed.data.emails);

    return res.status(200).json(result);
  }

  /**
   * POST /segments/:id/compute
   * Recompute segment membership for all contacts
   */
  @Post(':id/compute')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async compute(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    // Plunk Lite: the request writes the membership and queues its events, without running their
    // workflows while the dashboard waits
    const result = await SegmentService.computeMembership(auth.projectId!, segmentId, {events: 'background'});

    return res.status(200).json(result);
  }

  /**
   * POST /segments/:id/refresh
   * Refresh segment member count
   */
  @Post(':id/refresh')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async refresh(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    const memberCount = await SegmentService.refreshMemberCount(auth.projectId!, segmentId);

    return res.status(200).json({memberCount});
  }
}
