import {Prisma} from '@plunk/db';
import type {NextFunction, Request, Response} from 'express';
import {prisma} from '../database/prisma.js';
import {logger} from '../utils/logger.js';

/**
 * Check if request logging is enabled via environment variable
 * Set REQUEST_LOGGING=false to disable database logging entirely
 */
const REQUEST_LOGGING_ENABLED = process.env.REQUEST_LOGGING !== 'false';

/**
 * Endpoints to exclude from database logging
 *
 * Guidelines for what to skip:
 * - Health checks and monitoring endpoints (called by load balancers every few seconds)
 * - User session/auth endpoints (called on every page load in the dashboard)
 * - Real-time polling endpoints (called repeatedly for live updates)
 * - Static asset requests (should be served by CDN anyway)
 * - Internal/admin-only endpoints that don't need audit trails
 *
 * What TO log (valuable for analytics/debugging):
 * - Public API endpoints (/v1/send, /v1/track) - track customer usage
 * - Resource CRUD operations (contacts, templates, campaigns) - audit trail
 * - Authentication attempts (login, signup) - security monitoring
 * - Payment/billing operations - compliance
 * - Failed requests, except the 401s and 403s of made-up or refused keys on /v1/* (counted in a
 *   warning instead) and rows dropped under load (see MAX_LOG_WRITES_IN_FLIGHT)
 */
const SKIP_LOGGING_PATHS = [
  // Health/status checks (called by load balancers constantly)
  '/health',
  '/',

  // User session endpoints (called on every dashboard page load)
  '/users/@me',
  '/users/@me/projects',
  '/users/me',
  '/users/me/projects',

  // Project switching (called frequently when user switches projects)
  '/users/@me/projects/:id',

  // Real-time polling/stats endpoints
  '/queue/stats',

  // Feature flags/config (called on app initialization)
  '/config',
  '/config/features',
  '/oauth-config',

  // Field introspection (called when building forms/filters)
  '/contacts/fields',
  '/events/names',

  // Plunk Lite: called on every visit to the login page, and on logging out; neither is rate limited
  '/auth/oauth-config',
  '/auth/logout',
];

/**
 * Path patterns to exclude (regex)
 * For more complex matching like "/assets/*" or "*.json"
 */
const SKIP_LOGGING_PATTERNS = [
  /^\/assets\//i, // Static assets
  /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i, // Static files
];

/**
 * Check if a request should be logged to the database
 */
function shouldLogRequest(req: Request): boolean {
  const path = logger.path(req);

  // Check exact path matches
  if (SKIP_LOGGING_PATHS.includes(path)) {
    return false;
  }

  // Check pattern matches
  if (SKIP_LOGGING_PATTERNS.some(pattern => pattern.test(path))) {
    return false;
  }

  // Log everything else
  return true;
}

/**
 * Middleware to log API requests to the database for historical tracking and analytics
 * This runs asynchronously and does not block the response
 *
 * IMPORTANT: Only logs important endpoints to avoid noise and reduce database load
 *
 * Configuration:
 * - Set REQUEST_LOGGING=false to disable entirely
 * - Modify SKIP_LOGGING_PATHS to exclude specific endpoints
 * - Modify SKIP_LOGGING_PATTERNS to exclude path patterns
 */
export const databaseRequestLogger = (req: Request, res: Response, next: NextFunction) => {
  // Check if logging is enabled
  if (!REQUEST_LOGGING_ENABLED) {
    return next();
  }

  // Skip logging for excluded endpoints
  if (!shouldLogRequest(req)) {
    return next();
  }

  const startTime = Date.now();

  // Capture the original res.json to log after response
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    // Call original json method first
    const result = originalJson(body);

    // Log to database asynchronously (don't await, don't block response)
    void logRequestToDatabase(req, res, startTime, body);

    return result;
  };

  next();
};

/**
 * Plunk Lite: most rows written to api_requests at once; past it, rows are dropped, not queued.
 * Sign-ins and sign-ups, the audit trail, have a few more places of their own, so a burst elsewhere
 * cannot keep them out; still a bounded number, as login is rate limited per address, not per caller.
 */
const MAX_LOG_WRITES_IN_FLIGHT = 4;
const AUDITED_WRITES_EXTRA = 4;
const AUDITED_PATHS = new Set(['/auth/login', '/auth/signup']);
const SKIPPED_WARNING_INTERVAL_MS = 60_000;
let logWritesInFlight = 0;
const skipped = {droppedUnderLoad: 0, refusedWithoutProject: 0};
let lastSkippedWarningAt = 0;

/**
 * Plunk Lite: responses not worth a row. SNS notifications that were handled -- two or three per
 * email sent -- and the 401s and 403s of made-up or refused keys on the public API, which cost
 * nothing to send in bulk; those are counted in the warning below instead, so someone trying keys
 * still shows in the logs.
 */
function skipsRow(path: string, statusCode: number, authenticated: boolean): boolean {
  if (path === '/webhooks/sns') {
    return statusCode < 400;
  }
  if (path.startsWith('/v1/') && (statusCode === 401 || statusCode === 403) && !authenticated) {
    skipped.refusedWithoutProject++;
    return true;
  }
  return false;
}

/** Plunk Lite: what was not written, at most once a minute */
function warnSkipped(res: Response): void {
  if (Date.now() - lastSkippedWarningAt < SKIPPED_WARNING_INTERVAL_MS) {
    return;
  }
  if (skipped.droppedUnderLoad === 0 && skipped.refusedWithoutProject === 0) {
    return;
  }
  lastSkippedWarningAt = Date.now();
  logger.warn('API requests not written to api_requests', {...skipped}, res);
  skipped.droppedUnderLoad = 0;
  skipped.refusedWithoutProject = 0;
}

/**
 * Log the request to the database
 * This runs asynchronously and failures are logged but don't affect the response
 */
async function logRequestToDatabase(
  req: Request,
  res: Response,
  startTime: number,
  responseBody: unknown,
): Promise<void> {
  let claimed = false;
  try {
    const requestId = res.locals.requestId as string | undefined;
    const auth = res.locals.auth as {type?: string; userId?: string; projectId?: string} | undefined;

    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    const path = logger.path(req);
    const skips = skipsRow(path, statusCode, Boolean(auth));
    // Plunk Lite: under a burst, the log gives way rather than holding database connections
    const cap = AUDITED_PATHS.has(path) ? MAX_LOG_WRITES_IN_FLIGHT + AUDITED_WRITES_EXTRA : MAX_LOG_WRITES_IN_FLIGHT;
    const dropped = !skips && logWritesInFlight >= cap;
    if (dropped) {
      skipped.droppedUnderLoad++;
    }
    warnSkipped(res);
    if (skips || dropped) {
      return;
    }
    logWritesInFlight++;
    claimed = true;

    // Extract error information if this is an error response
    let errorCode: string | undefined;
    let errorMessage: string | undefined;

    if (
      statusCode >= 400 &&
      responseBody &&
      typeof responseBody === 'object' &&
      'error' in responseBody &&
      responseBody.error &&
      typeof responseBody.error === 'object'
    ) {
      const error = responseBody.error as {code?: string; message?: string};
      errorCode = error.code;
      errorMessage = error.message;
    }

    // Calculate request/response sizes (approximate)
    const requestSize = req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : undefined;
    const responseSize = JSON.stringify(responseBody).length;

    // Insert into database
    const row = {
      id: requestId || crypto.randomUUID(), // Use request ID as primary key
      method: req.method,
      // logger.path, not req.path: this runs from the res.json override, i.e.
      // inside the router, where req.path has been rewritten mount-relative.
      path,
      statusCode,
      duration,
      projectId: auth?.projectId || null,
      userId: auth?.userId || null,
      authType: auth?.type || null,
      ip: req.ip || req.socket.remoteAddress || null,
      userAgent: req.get('user-agent') || null,
      errorCode: errorCode || null,
      errorMessage: errorMessage || null,
      requestSize: requestSize || null,
      responseSize,
    };
    try {
      await prisma.apiRequest.create({data: row});
    } catch (error) {
      // Plunk Lite: a request id a client sent again is taken: the row gets one of the server's
      // instead, so reusing an id cannot keep a request out of the log
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
      await prisma.apiRequest.create({data: {...row, id: crypto.randomUUID()}});
    }

    // Log success for debugging (only in development)
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Request logged to database', {requestId}, res);
    }
  } catch (error) {
    // Log the error but don't throw - we don't want logging failures to affect the API
    logger.error('Failed to log request to database', error, {
      path: logger.path(req),
      method: req.method,
    });
  } finally {
    if (claimed) {
      logWritesInFlight--;
    }
  }
}
