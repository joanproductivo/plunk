import {Controller, Get, Middleware, Put} from '@overnightjs/core';
import {OptInSchemas, UtilitySchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';

import {ErrorCode, HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {MembershipService} from '../services/MembershipService.js';
import {OptInService} from '../services/OptInService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/** A project's double opt-in (Plunk Lite), which only the dashboard reads and its admins change. */
@Controller('projects')
export class OptInSettings {
  /**
   * GET /projects/:id/optin
   * Whether sign-ups wait for confirmation, the sender, and the project's own texts by language
   */
  @Get(':id/optin')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getSettings(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    if (auth.type !== 'jwt') {
      throw new HttpException(403, "A project's double opt-in is only available in the dashboard", ErrorCode.FORBIDDEN);
    }
    const {id} = UtilitySchemas.id.parse(req.params);

    await MembershipService.requireAccess(auth.userId!, id);

    return res.status(200).json(await OptInService.settings(id));
  }

  /**
   * PUT /projects/:id/optin
   * Replaces the project's double opt-in. Anything that cannot be kept is refused with the reason;
   * turning it on needs a sender on a verified domain of the project.
   */
  @Put(':id/optin')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async saveSettings(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    if (auth.type !== 'jwt') {
      throw new HttpException(
        403,
        "A project's double opt-in can only be changed in the dashboard",
        ErrorCode.FORBIDDEN,
      );
    }
    const {id} = UtilitySchemas.id.parse(req.params);

    await MembershipService.requireAdminAccess(auth.userId!, id);

    const body = OptInSchemas.update.safeParse(req.body);
    if (!body.success) {
      throw new HttpException(
        400,
        'The double opt-in needs enabled, fromEmail, fromName and texts',
        ErrorCode.INVALID_REQUEST_BODY,
      );
    }

    return res.status(200).json(await OptInService.saveSettings(id, body.data));
  }
}
