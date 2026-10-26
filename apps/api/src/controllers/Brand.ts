import {Controller, Get, Middleware, Put} from '@overnightjs/core';
import {BrandSchemas, UtilitySchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';

import {ErrorCode, HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {BrandService} from '../services/BrandService.js';
import {MembershipService} from '../services/MembershipService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/** A project's brand (Plunk Lite), which only the dashboard reads and its admins change. */
@Controller('projects')
export class Brand {
  /**
   * GET /projects/:id/brand
   * The brand new emails are written in, or the defaults if the project has none.
   */
  @Get(':id/brand')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getBrand(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    if (auth.type !== 'jwt') {
      throw new HttpException(403, "A project's brand is only available in the dashboard", ErrorCode.FORBIDDEN);
    }
    const {id} = UtilitySchemas.id.parse(req.params);

    await MembershipService.requireAccess(auth.userId!, id);

    return res.status(200).json(await BrandService.get(id));
  }

  /**
   * PUT /projects/:id/brand
   * Saves the project's brand, keeping only known fonts, `#rrggbb` colours and widths. Emails
   * already written keep their own.
   */
  @Put(':id/brand')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async saveBrand(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    if (auth.type !== 'jwt') {
      throw new HttpException(403, "A project's brand can only be changed in the dashboard", ErrorCode.FORBIDDEN);
    }
    const {id} = UtilitySchemas.id.parse(req.params);
    const body = BrandSchemas.update.safeParse(req.body);
    if (!body.success) {
      throw new HttpException(400, 'The brand must be an object', ErrorCode.INVALID_REQUEST_BODY);
    }

    await MembershipService.requireAdminAccess(auth.userId!, id);

    return res.status(200).json(await BrandService.save(id, body.data));
  }
}
