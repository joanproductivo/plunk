import {Controller, Get, Middleware, Put} from '@overnightjs/core';
import {FooterSchemas, toProjectFooters, UtilitySchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';

import {ErrorCode, HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {MembershipService} from '../services/MembershipService.js';
import {ProjectFooterService} from '../services/ProjectFooterService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/** A project's own unsubscribe footers (Plunk Lite), which only the dashboard reads and its admins change. */
@Controller('projects')
export class Footers {
  /**
   * GET /projects/:id/footers
   * The project's own footers by language; languages without one get Plunk's.
   */
  @Get(':id/footers')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getFooters(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    if (auth.type !== 'jwt') {
      throw new HttpException(403, "A project's footers are only available in the dashboard", ErrorCode.FORBIDDEN);
    }
    const {id} = UtilitySchemas.id.parse(req.params);

    await MembershipService.requireAccess(auth.userId!, id);

    return res.status(200).json(await ProjectFooterService.get(id));
  }

  /**
   * PUT /projects/:id/footers
   * Replaces the project's own footers. Anything that cannot be kept is refused with the reason,
   * rather than dropped.
   */
  @Put(':id/footers')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async saveFooters(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    if (auth.type !== 'jwt') {
      throw new HttpException(403, "A project's footers can only be changed in the dashboard", ErrorCode.FORBIDDEN);
    }
    const {id} = UtilitySchemas.id.parse(req.params);
    const body = FooterSchemas.update.safeParse(req.body);
    if (!body.success) {
      throw new HttpException(400, 'The footers must be an object', ErrorCode.INVALID_REQUEST_BODY);
    }
    const {footers, errors} = toProjectFooters(body.data);
    if (errors.length > 0) {
      throw new HttpException(400, errors.join('; '), ErrorCode.VALIDATION_ERROR);
    }

    await MembershipService.requireAdminAccess(auth.userId!, id);

    return res.status(200).json(await ProjectFooterService.save(id, footers));
  }
}
