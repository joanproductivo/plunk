import dayjs from 'dayjs';
import type {NextFunction, Request, Response} from 'express';
import jsonwebtoken from 'jsonwebtoken';

import type {AuthResponse} from '@plunk/types';

import {JWT_SECRET, PLUNK_ENABLED, PLUNK_LITE_PUBLIC_TRACK} from '../app/constants.js';
import {isAllowedOrigin} from '../app/origins.js';
import {ErrorCode, HttpException, NotAllowed, NotAuthenticated} from '../exceptions/index.js';
import {MembershipService} from '../services/MembershipService.js';
import {ProjectService} from '../services/ProjectService.js';
import {UserService} from '../services/UserService.js';

const INVALID_PUBLIC_KEY = 'Invalid public API key. Ensure you are using a public key (pk_*) for this endpoint.';
const INVALID_SECRET_KEY = 'Invalid secret API key. This endpoint requires a secret key (sk_*), not a public key.';
/** Plunk Lite: /v1/track takes either key, so its refusal names both */
const INVALID_TRACK_KEY =
  'Invalid API key. /v1/track takes a public key (pk_*) or a secret key (sk_*) of this project.';

/** Plunk Lite: what an API key can look like; anything else is refused without looking it up */
const API_KEY_PATTERN = /^(pk|sk)_[A-Za-z0-9_-]{8,128}$/;

/**
 * The API key of a "Bearer <key>" Authorization header. Plunk Lite: a value that cannot be a key
 * is refused here with `invalidKey`, so an invented one costs neither a query nor a cache entry.
 */
function bearerKey(authHeader: string, invalidKey: string): string {
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    throw new HttpException(
      401,
      'Authorization header must use Bearer token format: "Authorization: Bearer YOUR_API_KEY"',
      ErrorCode.MISSING_AUTH,
    );
  }

  const apiKey = parts[1];

  if (!apiKey) {
    throw new HttpException(401, 'API key is required in Authorization header', ErrorCode.MISSING_AUTH);
  }

  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new HttpException(401, invalidKey, ErrorCode.INVALID_API_KEY);
  }

  return apiKey;
}

/**
 * Middleware to check if this unsubscribe is authenticated on the dashboard
 * @param req
 * @param res
 * @param next
 */
export const isAuthenticated = (req: Request, res: Response, next: NextFunction) => {
  res.locals.auth = {type: 'jwt', userId: parseJwt(req)};

  next();
};

export const jwt = {
  /**
   * Extracts a unsubscribe id from a jwt
   * @param token The JWT token
   */
  verify(token: string): string | null {
    try {
      const verified = jsonwebtoken.verify(token, JWT_SECRET) as {
        id: string;
      };
      return verified.id;
    } catch {
      return null;
    }
  },
  /**
   * Signs a JWT token
   * @param id The user's ID to sign into a jwt token
   */
  sign(id: string): string {
    return jsonwebtoken.sign({id}, JWT_SECRET, {
      expiresIn: '168h',
    });
  },
  /**
   * Find out when a JWT expires
   * @param token The user's jwt token
   */
  expires(token: string): dayjs.Dayjs {
    const {exp} = jsonwebtoken.verify(token, JWT_SECRET) as {
      exp?: number;
    };
    return dayjs(exp);
  },
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reject state-changing requests sent by a browser from an origin outside the CORS allow-list.
 *
 * CORS only hides the response from other origins; the request itself still runs. Because the session
 * cookie is attached to cross-site form submissions, any route trusting the cookie alone is open to CSRF
 * without this check. Browsers always send `Origin` on non-GET requests, so a missing header means a
 * non-browser client, which cannot carry a victim's cookie. `Origin: null` is rejected.
 * @param request The express request object
 */
export function assertTrustedOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method)) {
    return;
  }

  const origin = request.headers.origin;

  if (origin !== undefined && !isAllowedOrigin(origin)) {
    throw new NotAllowed('Cross-origin requests are not allowed for this route');
  }
}

/**
 * Parse a user's ID from the request JWT token
 * @param request The express request object
 */
export function parseJwt(request: Request): string {
  assertTrustedOrigin(request);

  const token: string | undefined = request.cookies.next_token;

  if (!token) {
    throw new NotAuthenticated();
  }

  const id = jwt.verify(token);

  if (!id) {
    throw new NotAuthenticated();
  }

  return id;
}

/**
 * Middleware to require public API key authentication (for /v1/track endpoint only, through
 * requireTrackKey)
 * Validates that the request has a valid public key and sets the project
 * @param req
 * @param res
 * @param next
 */
// Plunk Lite: `invalidKey` (a default, so Express still sees a three-argument middleware) lets
// requireTrackKey refuse an unknown key with a message that names both keys
export const requirePublicKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
  invalidKey = INVALID_PUBLIC_KEY,
) => {
  try {
    // Get API key from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new HttpException(401, 'Authorization header is required', ErrorCode.MISSING_AUTH);
    }

    // Plunk Lite: a server can switch off the public key, which anyone who reads a page can copy
    if (!PLUNK_LITE_PUBLIC_TRACK) {
      throw new HttpException(
        403,
        'Public keys are switched off on this server (PLUNK_LITE_PUBLIC_TRACK=off). Call /v1/track from your server with a secret key (sk_*).',
        ErrorCode.FORBIDDEN,
      );
    }

    const apiKey = bearerKey(authHeader, invalidKey);

    // Look up project by public key only
    const project = await ProjectService.public(apiKey);

    if (!project) {
      throw new HttpException(401, invalidKey, ErrorCode.INVALID_API_KEY);
    }

    // Set auth response with project ID (before disabled check so it's available for logging)
    res.locals.auth = {
      type: 'apiKey',
      projectId: project.id,
      key: 'public',
    };

    // Check if project is disabled - block write operations
    if (project.disabled) {
      const method = req.method.toUpperCase();
      const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

      if (isWriteOperation) {
        throw new HttpException(
          403,
          'This project has been disabled. Please contact support for assistance.',
          ErrorCode.PROJECT_DISABLED,
        );
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Plunk Lite: the key /v1/track takes -- the public key, which a form can call it with from the
 * browser, or the secret key, from a server. The secret key does nothing it could not already do
 * with POST /contacts and POST /events/track, only in one call, and it is the way in when the public
 * key is switched off (PLUNK_LITE_PUBLIC_TRACK=off).
 */
export const requireTrackKey = (req: Request, res: Response, next: NextFunction) =>
  // Loosely, so a secret key in a malformed header gets the secret key's format error, not the switch's 403
  /^bearer\s+sk_/i.test(req.headers.authorization ?? '')
    ? requireSecretKey(req, res, next, INVALID_TRACK_KEY)
    : requirePublicKey(req, res, next, INVALID_TRACK_KEY);

/**
 * Middleware to require secret API key authentication
 * Validates that the request has a valid secret key and sets the project
 * @param req
 * @param res
 * @param next
 */
// Plunk Lite: `invalidKey` as for requirePublicKey
export const requireSecretKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
  invalidKey = INVALID_SECRET_KEY,
) => {
  try {
    // Get API key from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new HttpException(401, 'Authorization header is required', ErrorCode.MISSING_AUTH);
    }

    const apiKey = bearerKey(authHeader, invalidKey);

    // Look up project by secret key only
    const project = await ProjectService.secret(apiKey);

    if (!project) {
      throw new HttpException(401, invalidKey, ErrorCode.INVALID_API_KEY);
    }

    // Set auth response with project ID (before disabled check so it's available for logging)
    res.locals.auth = {
      type: 'apiKey',
      projectId: project.id,
      key: 'secret',
    };

    // Check if project is disabled - block write operations
    if (project.disabled) {
      const method = req.method.toUpperCase();
      const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

      if (isWriteOperation) {
        throw new HttpException(
          403,
          'This project has been disabled. Please contact support for assistance.',
          ErrorCode.PROJECT_DISABLED,
        );
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware to require authentication - supports both JWT and secret API key
 * For JWT: requires X-Project-Id header and validates user has access to the project
 * For API key: only accepts secret keys (sk_*), derives project from the key
 * @param req
 * @param res
 * @param next
 */
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check for API key first (Authorization header with Bearer token)
    const authHeader = req.headers.authorization;

    // If Authorization header is provided, use secret key authentication
    if (authHeader) {
      const apiKey = bearerKey(authHeader, INVALID_SECRET_KEY);
      // Look up project by secret key only (public keys not allowed)
      const project = await ProjectService.secret(apiKey);

      if (!project) {
        throw new HttpException(401, INVALID_SECRET_KEY, ErrorCode.INVALID_API_KEY);
      }

      // Set auth response with project ID (before disabled check so it's available for logging)
      res.locals.auth = {
        type: 'apiKey',
        projectId: project.id,
        key: 'secret',
      } as AuthResponse;

      // Check if project is disabled - block write operations
      if (project.disabled) {
        const method = req.method.toUpperCase();
        const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

        if (isWriteOperation) {
          throw new HttpException(
            403,
            'This project has been disabled. Please contact support for assistance.',
            ErrorCode.PROJECT_DISABLED,
          );
        }
      }

      return next();
    }

    // Otherwise, use JWT authentication
    const userId = parseJwt(req);

    // Get project ID from header (required for JWT auth)
    const projectId = req.headers['x-project-id'] as string | undefined;

    if (!projectId) {
      throw new HttpException(400, 'Project ID is required in X-Project-Id header', ErrorCode.BAD_REQUEST);
    }

    // Verify user has access to this project and get project status
    const [membership, project] = await Promise.all([
      MembershipService.getMembership(userId, projectId),
      ProjectService.id(projectId),
    ]);

    if (!membership) {
      throw new HttpException(403, 'You do not have access to this project', ErrorCode.PROJECT_ACCESS_DENIED);
    }

    // Set auth response with project ID (before disabled check so it's available for logging)
    res.locals.auth = {
      type: 'jwt',
      userId,
      projectId,
    };

    // Check if project is disabled - block write operations
    if (project?.disabled) {
      const method = req.method.toUpperCase();
      const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

      if (isWriteOperation) {
        throw new HttpException(
          403,
          'This project has been disabled. Please contact support for assistance.',
          ErrorCode.PROJECT_DISABLED,
        );
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware to require email verification
 * Must be used AFTER isAuthenticated or requireProjectAccess
 * @param req
 * @param res
 * @param next
 */
export const requireEmailVerified = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = res.locals.auth;

    if (auth.type === 'apiKey') {
      return next();
    }

    if (!auth.userId) {
      throw new NotAuthenticated();
    }

    const user = await UserService.id(auth.userId);

    if (!user) {
      throw new NotAuthenticated();
    }

    // If platform email verification is disabled, skip check
    if (!PLUNK_ENABLED) {
      return next();
    }

    // OAuth users are always considered verified
    if (user.type !== 'PASSWORD') {
      return next();
    }

    // PASSWORD users must verify email
    if (!user.emailVerified) {
      throw new HttpException(
        403,
        'Please verify your email address to access this resource',
        ErrorCode.EMAIL_VERIFICATION_REQUIRED,
      );
    }

    next();
  } catch (error) {
    next(error);
  }
};
