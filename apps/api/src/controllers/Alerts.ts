import {Controller, Get, Middleware, Post, Put} from '@overnightjs/core';
import {AlertSchemas, UtilitySchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';

import {ErrorCode, HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {FailureAlertService} from '../services/FailureAlertService.js';
import {MembershipService} from '../services/MembershipService.js';
import {QueueService} from '../services/QueueService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * A project's failure alerts (Plunk Lite): the failures the dashboard banner shows, and where the
 * alert emails go. Only the dashboard uses them; any member reviews failures, admins change where
 * the emails go and drain the AWS dead-letter queue of SES events.
 */
@Controller('projects')
export class Alerts {
  /** GET /projects/:id/alerts/settings */
  @Get(':id/alerts/settings')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getSettings(req: Request, res: Response, _next: NextFunction) {
    const id = await Alerts.project(req, res, 'member');
    return res.status(200).json({settings: await FailureAlertService.getSettings(id)});
  }

  /** PUT /projects/:id/alerts/settings — no addresses turn the alert emails off */
  @Put(':id/alerts/settings')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async saveSettings(req: Request, res: Response, _next: NextFunction) {
    const id = await Alerts.project(req, res, 'admin');
    const body = AlertSchemas.settings.safeParse(req.body);
    if (!body.success) {
      throw new HttpException(400, body.error.issues[0]?.message ?? 'Invalid settings', ErrorCode.VALIDATION_ERROR);
    }
    return res.status(200).json({settings: await FailureAlertService.saveSettings(id, body.data)});
  }

  /** POST /projects/:id/alerts/settings/test — a sample alert to the saved addresses */
  @Post(':id/alerts/settings/test')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async sendTest(req: Request, res: Response, _next: NextFunction) {
    const id = await Alerts.project(req, res, 'admin');
    try {
      await FailureAlertService.sendTest(id);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // What SES said, for the person who just pressed the button
      throw new HttpException(400, error instanceof Error ? error.message : 'The test alert could not be sent');
    }
    return res.status(200).json({success: true});
  }

  /**
   * POST /projects/:id/alerts/dead-letter-queue/drain — take back now what SNS left in the AWS
   * dead-letter queue of SES events. The queue is the installation's: what the drain does for this
   * project shows on its dashboard, and nothing of the others' is said here.
   */
  @Post(':id/alerts/dead-letter-queue/drain')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async drainDeadLetterQueue(req: Request, res: Response, _next: NextFunction) {
    await Alerts.project(req, res, 'admin');
    await QueueService.queueDlqDrain();
    return res.status(202).json({queued: true});
  }

  /** GET /projects/:id/alerts/failures — the sources with failures not reviewed yet */
  @Get(':id/alerts/failures')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async listFailures(req: Request, res: Response, _next: NextFunction) {
    const id = await Alerts.project(req, res, 'member');
    return res.status(200).json({failures: await FailureAlertService.listOpen(id)});
  }

  /** POST /projects/:id/alerts/failures/review — marks reviewed what the banner showed */
  @Post(':id/alerts/failures/review')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async reviewFailures(req: Request, res: Response, _next: NextFunction) {
    const id = await Alerts.project(req, res, 'member');
    const body = AlertSchemas.review.safeParse(req.body);
    if (!body.success) {
      throw new HttpException(
        400,
        'Send the failures that were shown, each with its lastAt',
        ErrorCode.INVALID_REQUEST_BODY,
      );
    }
    return res.status(200).json({reviewed: await FailureAlertService.review(id, body.data.seen)});
  }

  /** The project in the path, once the dashboard user is allowed to act on it */
  private static async project(req: Request, res: Response, role: 'member' | 'admin'): Promise<string> {
    const auth = res.locals.auth;
    if (auth.type !== 'jwt') {
      throw new HttpException(403, 'Failure alerts are only available in the dashboard', ErrorCode.FORBIDDEN);
    }
    const {id} = UtilitySchemas.id.parse(req.params);
    if (role === 'admin') {
      await MembershipService.requireAdminAccess(auth.userId!, id);
    } else {
      await MembershipService.requireAccess(auth.userId!, id);
    }
    return id;
  }
}
