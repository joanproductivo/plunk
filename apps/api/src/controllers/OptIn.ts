import {Controller, Post} from '@overnightjs/core';
import {OptInSchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';

import {OptInService} from '../services/OptInService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

// The token comes in the body, never the path: request logs keep paths, and the link carries it
// after a `#`, which the browser does not send either. Anything else reads as a link that does not work.
function readToken(req: Request): string {
  const body = OptInSchemas.token.safeParse(req.body);
  return body.success ? body.data.token : '';
}

/** PUBLIC: the page a double opt-in email links to (Plunk Lite). No session: the token is the key. */
@Controller('optin')
export class OptIn {
  /**
   * POST /optin/describe
   * What the confirmation page shows: whether the link still confirms, for which address and
   * project, and in which language. Changes nothing, so a link scanner opening it confirms nothing.
   */
  @Post('describe')
  @CatchAsync
  public async describe(req: Request, res: Response, _next: NextFunction) {
    return res.status(200).json(await OptInService.describe(readToken(req)));
  }

  /**
   * POST /optin/confirm
   * Confirms the sign-up the link belongs to: `confirmed` (now or before) or `invalid`.
   */
  @Post('confirm')
  @CatchAsync
  public async confirm(req: Request, res: Response, _next: NextFunction) {
    return res.status(200).json({status: await OptInService.confirm(readToken(req))});
  }
}
