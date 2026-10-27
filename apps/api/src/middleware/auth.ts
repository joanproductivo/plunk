import dayjs from 'dayjs';
import type {NextFunction, Request, Response} from 'express';
import jsonwebtoken from 'jsonwebtoken';

import type {AuthResponse} from '@plunk/types';

import {JWT_SECRET, PLUNK_ENABLED} from '../app/constants.js';
import {isAllowedOrigin} from '../app/origins.js';
import {ErrorCode, HttpException, NotAllowed, NotAuthenticated} from '../exceptions/index.js';
import {MembershipService} from '../services/MembershipService.js';
import {ProjectService} from '../services/ProjectService.js';
import {UserService} from '../services/UserService.js';

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

/**
 * Methods that change nothing. The cookie check below lists these rather than the methods that
 * write, so a method in neither list is still checked.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Parse a user's ID from the request JWT token
 * @param request The express request object
 */
export function parseJwt(request: Request): string {
  // The session cookie rides along on requests from any site (SameSite=None, so the dashboard can
  // reach the API on another site), and CORS only stops other sites from reading the answer. A
  // browser always names the page's origin on these methods, so one from elsewhere is turned away
  // before the cookie is trusted; a client outside the browser sends no Origin and is unaffected.
  const origin = request.headers.origin;
  if (!SAFE_METHODS.has(request.method) && origin !== undefined && !isAllowedOrigin(origin)) {
    throw new NotAllowed('Requests from other sites cannot use the dashboard session');
  }

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
 * Middleware to require public API key authentication (for /v1/track endpoint only)
 * Validates that the request has a valid public key and sets the project
 * @param req
 * @param res
 * @param next
 */
export const requirePublicKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get API key from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new HttpException(401, 'Authorization header is required', ErrorCode.MISSING_AUTH);
    }

    // Support "Bearer <key>" format
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

    // Look up project by public key only
    const project = await ProjectService.public(apiKey);

    if (!project) {
      throw new HttpException(
        401,
        'Invalid public API key. Ensure you are using a public key (pk_*) for this endpoint.',
        ErrorCode.INVALID_API_KEY,
      );
    }

    // Set auth response with project ID (before disabled check so it's available for logging)
    res.locals.auth = {
      type: 'apiKey',
      projectId: project.id,
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
 * Middleware to require secret API key authentication
 * Validates that the request has a valid secret key and sets the project
 * @param req
 * @param res
 * @param next
 */
export const requireSecretKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get API key from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new HttpException(401, 'Authorization header is required', ErrorCode.MISSING_AUTH);
    }

    // Support "Bearer <key>" format
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

    // Look up project by secret key only
    const project = await ProjectService.secret(apiKey);

    if (!project) {
      throw new HttpException(
        401,
        'Invalid secret API key. This endpoint requires a secret key (sk_*), not a public key.',
        ErrorCode.INVALID_API_KEY,
      );
    }

    // Set auth response with project ID (before disabled check so it's available for logging)
    res.locals.auth = {
      type: 'apiKey',
      projectId: project.id,
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
      // Support "Bearer <key>" format
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
      // Look up project by secret key only (public keys not allowed)
      const project = await ProjectService.secret(apiKey);

      if (!project) {
        throw new HttpException(
          401,
          'Invalid secret API key. This endpoint requires a secret key (sk_*), not a public key.',
          ErrorCode.INVALID_API_KEY,
        );
      }

      // Set auth response with project ID (before disabled check so it's available for logging)
      res.locals.auth = {
        type: 'apiKey',
        projectId: project.id,
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
