import type {Server as HttpServer} from 'node:http';

import {Server} from '@overnightjs/core';
import cookies from 'cookie-parser';
import cors from 'cors';
import type {NextFunction, Request, Response} from 'express';
import {raw} from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import signale from 'signale';
import {ZodError} from 'zod';

import {
  GITHUB_OAUTH_ENABLED,
  GOOGLE_OAUTH_ENABLED,
  LANDING_URI,
  NODE_ENV,
  PLUNK_ENABLED,
  PORT,
  RATE_LIMIT_CONTACTS_PER_SECOND,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_SEND_PER_SECOND,
  RATE_LIMIT_TRACK_PER_SECOND,
  SHUTDOWN_TIMEOUT_MS,
  S3_ENABLED,
  SMTP_ENABLED,
  STRIPE_ENABLED,
  TRACKING_TOGGLE_ENABLED,
  verifySignupsEnabled,
} from './app/constants.js';
import {allowedOrigins, isAllowedOrigin} from './app/origins.js';
import {Actions} from './controllers/Actions.js';
import {Activity} from './controllers/Activity.js';
import {Alerts} from './controllers/Alerts.js';
import {Analytics} from './controllers/Analytics.js';
import {Auth} from './controllers/Auth.js';
import {Brand} from './controllers/Brand.js';
import {Campaigns} from './controllers/Campaigns.js';
import {Contacts} from './controllers/Contacts.js';
import {Domains} from './controllers/Domains.js';
import {Events} from './controllers/Events.js';
import {Footers} from './controllers/Footers.js';
import {Oauth} from './controllers/Oauth/index.js';
import {Projects} from './controllers/Projects.js';
import {Segments} from './controllers/Segments.js';
import {Templates} from './controllers/Templates.js';
import {Unsubscribe} from './controllers/Unsubscribe.js';
import {Uploads} from './controllers/Uploads.js';
import {Users} from './controllers/Users.js';
import {Webhooks} from './controllers/Webhooks.js';
import {Workflows} from './controllers/Workflows.js';
import {Config} from './controllers/Config.js';
import {prisma} from './database/prisma.js';
import {ErrorCode, type FieldError, HttpException, ValidationError} from './exceptions/index.js';
import {
  apiRequestCleanupQueue,
  campaignStatsSweepQueue,
  domainVerificationQueue,
  cardVerificationSweepQueue,
  emailBodyCleanupQueue,
  idempotencyKeyCleanupQueue,
  segmentCountQueue,
  emailRecoverySweepQueue,
  snoozeSweepQueue,
  plunkLiteChecksQueue,
} from './services/QueueService.js';
import {EmailVerificationService} from './services/EmailVerificationService.js';
import * as S3Service from './services/S3Service.js';
import {checkConfigurationSets} from './services/SesEventMatch.js';
import {useJsonBodyParsers} from './middleware/bodyParsers.js';
import {requestIdMiddleware} from './middleware/requestId.js';
import {databaseRequestLogger} from './middleware/requestLogger.js';
import {logger, requestLogger} from './utils/logger.js';

const server = new (class extends Server {
  public constructor() {
    super();

    // Specify that we need raw json for the webhook
    this.app.use('/webhooks/incoming/stripe', raw({type: 'application/json'}));

    // Set the content-type to JSON for any request coming from AWS SNS
    this.app.use(function (req, res, next) {
      if (req.get('x-amz-sns-message-type')) {
        req.headers['content-type'] = 'application/json';
      }
      next();
    });

    // Parse the rest of our application as json
    useJsonBodyParsers(this.app);
    this.app.use(cookies());
    this.app.use(helmet());

    // Add request ID to all requests for tracking
    this.app.use(requestIdMiddleware);

    // Log all requests and responses with request ID (console/file logs)
    this.app.use(requestLogger);

    // Log all requests to database for historical tracking and analytics
    this.app.use(databaseRequestLogger);

    // Public API endpoints that should allow all origins
    const publicApiPaths = ['/v1', '/v1/track', '/v1/send'];

    // Log CORS configuration on startup
    signale.info('CORS configuration', {
      environment: NODE_ENV,
      allowedOrigins: allowedOrigins.map(o => (o instanceof RegExp ? o.toString() : o)),
      publicApiPaths,
    });

    // Apply restrictive CORS to all routes EXCEPT public API endpoints
    this.app.use((req, res, next) => {
      // Check if this is a public API endpoint
      const isPublicApi = publicApiPaths.some(path => req.path === path || req.path.startsWith(path + '/'));

      if (isPublicApi) {
        // For public API endpoints, allow all origins
        res.set({
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        // Handle preflight
        if (req.method === 'OPTIONS') {
          return res.sendStatus(200);
        }
        return next();
      }

      // For other endpoints, apply restrictive CORS
      cors({
        origin: (origin, callback) => {
          // Allow requests with no origin (e.g., mobile apps, curl, server-to-server)
          if (!origin) {
            return callback(null, true);
          }

          if (isAllowedOrigin(origin)) {
            callback(null, true);
          } else {
            // Log CORS rejection with helpful information
            signale.warn('CORS request rejected', {
              origin,
              allowedOrigins: allowedOrigins.map(o => (o instanceof RegExp ? o.toString() : o)),
              hint: 'If using HTTPS, ensure USE_HTTPS=true is set in your environment variables',
            });
            // Reject the CORS request by passing false (don't send CORS headers)
            callback(null, false);
          }
        },
        credentials: true,
      })(req, res, next);
    });

    this.app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'short'));

    this.addControllers([
      new Actions(),
      new Activity(),
      new Alerts(),
      new Analytics(),
      new Auth(),
      new Brand(),
      new Campaigns(),
      new Oauth(),
      new Users(),
      new Contacts(),
      new Domains(),
      new Footers(),
      new Projects(),
      new Segments(),
      new Templates(),
      new Unsubscribe(),
      new Uploads(),
      new Webhooks(),
      new Workflows(),
      new Events(),
      new Config(),
    ]);

    this.app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'ok',
        time: Date.now(),
        environment: NODE_ENV,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
      });
    });

    this.app.get('/', (_, res) => res.redirect(LANDING_URI));

    this.app.use('*', () => {
      throw new HttpException(404, 'Unknown route');
    });
  }
})();

/**
 * Standardized error response format
 */
interface ErrorResponse {
  success: false;
  error: {
    code: string; // Machine-readable error code (e.g., "VALIDATION_ERROR")
    message: string; // Human-readable error message
    statusCode: number; // HTTP status code
    requestId?: string; // Request ID for tracking
    errors?: FieldError[]; // Field-level validation errors
    details?: Record<string, unknown>; // Additional error context
    suggestion?: string; // Helpful suggestion for fixing the error
  };
  timestamp: string; // ISO timestamp
}

server.app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = res.locals.requestId as string | undefined;

  // Handle JSON parsing errors (from express.json() middleware)
  if (error instanceof SyntaxError && 'body' in error) {
    const statusCode = 400;

    logger.warn(
      'JSON parsing failed',
      {
        endpoint: `${req.method} ${req.path}`,
        contentType: req.get('content-type'),
      },
      res,
    );

    const response: ErrorResponse = {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid JSON in request body',
        statusCode,
        requestId,
        suggestion: 'Ensure your request body is valid JSON and Content-Type header is set to "application/json".',
      },
      timestamp: new Date().toISOString(),
    };

    return res.status(statusCode).json(response);
  }

  // A body over the parser's limit: the client's to fix, not a server error
  if ((error as {type?: unknown}).type === 'entity.too.large') {
    const statusCode = 413;

    logger.warn('Request body too large', {endpoint: `${req.method} ${req.path}`}, res);

    const response: ErrorResponse = {
      success: false,
      error: {
        code: ErrorCode.INVALID_REQUEST_BODY,
        message: 'Request body is too large',
        statusCode,
        requestId,
        suggestion: 'Send a smaller body. Attachments to /v1/send can add up to about 7 MB.',
      },
      timestamp: new Date().toISOString(),
    };

    return res.status(statusCode).json(response);
  }

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    const fieldErrors: FieldError[] = error.errors.map(err => ({
      field: err.path.join('.'),
      message: err.message,
      code: err.code,
      received: err.code !== 'invalid_type' ? undefined : 'received' in err ? err.received : undefined,
    }));

    const statusCode = 422;

    // Create helpful suggestions based on common validation errors
    let suggestion = 'Please check the API documentation for the correct request format.';
    if (fieldErrors.some(e => e.code === 'invalid_type')) {
      suggestion =
        'One or more fields have incorrect types. Check that strings are quoted, numbers are unquoted, and booleans are true/false.';
    } else if (fieldErrors.some(e => e.message.includes('required'))) {
      suggestion = 'Required fields are missing. Ensure all required fields are included in your request.';
    }

    // Log validation errors with structured logging
    logger.warn(
      'Validation failed',
      {
        endpoint: `${req.method} ${req.path}`,
        fieldCount: fieldErrors.length,
        fields: fieldErrors.map(e => e.field),
      },
      res,
    );

    const response: ErrorResponse = {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Request validation failed',
        statusCode,
        requestId,
        errors: fieldErrors,
        suggestion,
      },
      timestamp: new Date().toISOString(),
    };

    return res.status(statusCode).json(response);
  }

  // Handle custom HTTP exceptions
  if (error instanceof HttpException) {
    const statusCode = error.code;
    const errorCode = error.errorCode || ErrorCode.INTERNAL_SERVER_ERROR;

    // Extract validation errors if this is a ValidationError
    const validationError = error instanceof ValidationError ? error : null;

    // Log based on severity with structured logging
    if (statusCode >= 500) {
      logger.error(
        error.message,
        error,
        {
          endpoint: `${req.method} ${req.path}`,
          errorCode,
          statusCode,
        },
        res,
      );
    } else if (statusCode >= 400) {
      logger.warn(
        error.message,
        {
          endpoint: `${req.method} ${req.path}`,
          errorCode,
          statusCode,
        },
        res,
      );
    }

    // Generate helpful suggestions based on error type
    let suggestion: string | undefined;
    switch (errorCode) {
      case ErrorCode.INVALID_API_KEY:
        suggestion = 'Verify your API key is correct and starts with "sk_" for secret keys or "pk_" for public keys.';
        break;
      case ErrorCode.MISSING_AUTH:
        suggestion = 'Include an Authorization header with format: "Authorization: Bearer YOUR_API_KEY"';
        break;
      case ErrorCode.FORBIDDEN:
        suggestion =
          'This action requires additional permissions. Check that you have access to this resource or contact support.';
        break;
      case ErrorCode.TEMPLATE_NOT_FOUND:
        suggestion =
          'Ensure the template ID is correct and belongs to your project. You can list available templates via the API.';
        break;
      case ErrorCode.VALIDATION_ERROR:
        suggestion = 'Check the "errors" array for specific field-level validation issues.';
        break;
      case ErrorCode.RATE_LIMIT_EXCEEDED:
        suggestion = 'You have exceeded the rate limit. Wait a moment before retrying, or upgrade your plan.';
        break;
      case ErrorCode.UPGRADE_REQUIRED:
        suggestion = 'This feature requires a higher plan. Visit your dashboard to upgrade.';
        break;
      case ErrorCode.PROJECT_DISABLED:
        suggestion = 'Your project has been disabled. Contact support for assistance.';
        break;
      case ErrorCode.IDEMPOTENCY_KEY_REUSED:
        suggestion =
          'This Idempotency-Key was already used, so the request was refused rather than performed twice. Generate a new key for a genuinely new request.';
        break;
    }

    const response: ErrorResponse = {
      success: false,
      error: {
        code: errorCode,
        message: error.message,
        statusCode,
        requestId,
        errors: validationError?.errors,
        details: error.details,
        suggestion,
      },
      timestamp: new Date().toISOString(),
    };

    return res.status(statusCode).json(response);
  }

  // Handle unexpected errors (not HttpException)
  const statusCode = 500;
  logger.error(
    'Unexpected error occurred',
    error,
    {
      endpoint: `${req.method} ${req.path}`,
    },
    res,
  );

  const response: ErrorResponse = {
    success: false,
    error: {
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred',
      statusCode,
      requestId,
      suggestion: 'This is an internal server error. Please contact support with the request ID if the issue persists.',
    },
    timestamp: new Date().toISOString(),
  };

  res.status(statusCode).json(response);
});

// Global error handlers to prevent server crashes
process.on('unhandledRejection', (reason, promise) => {
  signale.error('Unhandled Promise Rejection:', reason);
  signale.error('Promise:', promise);
  // Don't exit the process - just log the error
});

process.on('uncaughtException', error => {
  signale.error('Uncaught Exception:', error);
  // Plunk Lite: the process may be left in any state, so close as on a signal -- letting the
  // requests running finish -- and exit with an error so pm2 starts it again, as the worker does
  shutdown('uncaughtException', 1);
});

let httpServer: HttpServer | undefined;
let stopping = false;

/**
 * Stop taking requests and let the running ones finish: a request cut off between creating an
 * email row and queueing its job would leave the row PENDING with nothing to send it. Work a
 * request starts without awaiting it (a manual workflow start) is not waited for.
 */
function shutdown(signal: string, exitCode = 0) {
  // A second signal must not fall through to Node's default handler, which exits at once
  if (stopping) {
    return;
  }
  stopping = true;

  signale.info(`[API] Received ${signal}, closing the HTTP server...`);

  const deadline = setTimeout(() => {
    signale.error(`[API] Requests did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000}s, exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  if (!httpServer) {
    process.exit(exitCode);
  }

  // Stops accepting connections and waits for the requests already running
  httpServer.close(() => {
    signale.success('[API] HTTP server closed');
    process.exit(exitCode);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void prisma.$connect().then(async () => {
  httpServer = server.app.listen(PORT, '0.0.0.0', () => signale.success('[HTTPS] Ready on', PORT));

  // Plunk Lite: the disposable domains list, fetched before the first sign-up needs it
  if (verifySignupsEnabled()) {
    void EmailVerificationService.warmUp();
  }

  // Feature matrix
  const features = [
    {
      name: 'Billing (Stripe)',
      enabled: STRIPE_ENABLED,
      details: STRIPE_ENABLED ? 'Stripe billing enabled' : 'No Stripe keys configured',
    },
    {
      name: 'File uploads (S3)',
      enabled: S3_ENABLED,
      details: S3_ENABLED ? 'S3 storage enabled' : 'S3 credentials missing',
    },
    {name: 'SMTP relay', enabled: SMTP_ENABLED, details: SMTP_ENABLED ? 'SMTP server enabled' : 'SMTP disabled'},
    {
      name: 'OAuth - GitHub',
      enabled: GITHUB_OAUTH_ENABLED,
      details: GITHUB_OAUTH_ENABLED ? 'GitHub login enabled' : 'GitHub OAuth not configured',
    },
    {
      name: 'OAuth - Google',
      enabled: GOOGLE_OAUTH_ENABLED,
      details: GOOGLE_OAUTH_ENABLED ? 'Google login enabled' : 'Google OAuth not configured',
    },
    {
      name: 'Tracking toggle',
      enabled: TRACKING_TOGGLE_ENABLED,
      details: TRACKING_TOGGLE_ENABLED
        ? 'Per-project tracking toggle enabled'
        : 'Always tracking or always no-tracking',
    },
    {
      name: 'Platform emails',
      enabled: PLUNK_ENABLED,
      details: PLUNK_ENABLED ? 'Platform email notifications enabled' : 'PLUNK_API_KEY not configured',
    },
    {
      name: 'API rate limiting',
      enabled: RATE_LIMIT_ENABLED,
      details: RATE_LIMIT_ENABLED
        ? `track ${RATE_LIMIT_TRACK_PER_SECOND}/s, send ${RATE_LIMIT_SEND_PER_SECOND}/s, contacts ${RATE_LIMIT_CONTACTS_PER_SECOND}/s`
        : 'Disabled via RATE_LIMIT_ENABLED=false',
    },
  ];

  const rows = features.map(f => ({
    Feature: f.name,
    Enabled: f.enabled ? '✅' : '❌',
  }));

  console.table(rows);

  if (S3_ENABLED) {
    try {
      await S3Service.initializeBucket();
    } catch (error) {
      signale.error('[S3] Failed to initialize bucket:', error);
      signale.warn('[S3] File uploads may not work properly');
    }
  }

  // Not awaited: a slow SES response must not hold up scheduling the background jobs below.
  // Plunk Lite: a set that does not publish its bounces and complaints is told to every project.
  void checkConfigurationSets();

  scheduleRepeatables();
}, startupFailed);

/**
 * Plunk Lite: the database could not be reached at startup. Exit so pm2 starts the api again;
 * staying up would leave a process that never listens and that pm2 thinks is fine.
 */
function startupFailed(error: unknown): never {
  signale.error('[API] Could not connect to the database, exiting so pm2 restarts the api:', error);
  process.exit(1);
}

/**
 * Plunk Lite: schedule the repeatable jobs, and if one cannot be added, all of them again in 30
 * seconds, since each has a fixed id and adding it again changes nothing. Before, a failure skipped
 * the jobs after it until the next restart, without a word.
 */
function scheduleRepeatables(): void {
  addRepeatables().catch((error: unknown) => {
    signale.error('[BACKGROUND-JOB] Could not schedule the repeatable jobs, trying again in 30 seconds:', error);
    setTimeout(scheduleRepeatables, 30_000).unref();
  });
}

async function addRepeatables(): Promise<void> {
  // Set up repeatable job for domain verification (BullMQ)
  // Run every 5 minutes to check domain verification status with AWS SES
  await domainVerificationQueue.add(
    'check-domain-verification',
    {},
    {
      repeat: {
        pattern: '*/5 * * * *', // Every 5 minutes
      },
      jobId: 'domain-verification-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Domain verification scheduled (BullMQ repeatable job, runs every 5 minutes)');

  // Set up repeatable job for segment count updates (BullMQ)
  // Run every 5 minutes to compute membership changes and trigger events
  await segmentCountQueue.add(
    'update-segment-counts',
    {},
    {
      repeat: {
        pattern: '*/5 * * * *', // Every 5 minutes
      },
      jobId: 'segment-count-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Segment count updater scheduled (BullMQ repeatable job, runs every 5 minutes)');

  // Set up repeatable job for API request log cleanup (BullMQ)
  // Run daily at 3 AM to clean up old request logs
  await apiRequestCleanupQueue.add(
    'cleanup-old-requests',
    {},
    {
      repeat: {
        pattern: '0 3 * * *', // Daily at 3 AM
      },
      jobId: 'api-request-cleanup-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] API request cleanup scheduled (BullMQ repeatable job, runs daily at 3 AM)');

  // Set up repeatable job for expired idempotency key cleanup (BullMQ)
  // Runs hourly: expiry is what makes a key reusable, so the sweep should track the TTL
  await idempotencyKeyCleanupQueue.add(
    'cleanup-expired-keys',
    {},
    {
      repeat: {
        pattern: '0 * * * *', // Hourly, on the hour
      },
      jobId: 'idempotency-key-cleanup-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Idempotency key cleanup scheduled (BullMQ repeatable job, runs hourly)');

  // Set up repeatable job for email body cleanup (BullMQ)
  // Run daily at 4 AM, offset from the API request cleanup so the two don't overlap
  await emailBodyCleanupQueue.add(
    'cleanup-old-email-bodies',
    {},
    {
      repeat: {
        pattern: '0 4 * * *', // Daily at 4 AM
      },
      jobId: 'email-body-cleanup-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Email body cleanup scheduled (BullMQ repeatable job, runs daily at 4 AM)');

  // Set up repeatable job for card verification reconciliation (BullMQ)
  // Every 15 minutes: a project stuck without a verification verdict is still able to send,
  // so the window between the stall and someone noticing is the exposure being closed.
  await cardVerificationSweepQueue.add(
    'sweep-stalled-verifications',
    {},
    {
      repeat: {
        pattern: '*/15 * * * *', // Every 15 minutes
      },
      jobId: 'card-verification-sweep-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Card verification sweep scheduled (BullMQ repeatable job, runs every 15 minutes)');

  // Set up repeatable job for campaign stats reconciliation (BullMQ)
  // Every 2 minutes: opens and clicks arrive long after a campaign finalizes, and the counters
  // the stats endpoint reads are only written by a reconcile. This is the lag between an event
  // landing on the email row and the campaign reporting it.
  await campaignStatsSweepQueue.add(
    'sweep-dirty-campaign-stats',
    {},
    {
      repeat: {
        pattern: '*/2 * * * *', // Every 2 minutes
      },
      jobId: 'campaign-stats-sweep-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Campaign stats sweep scheduled (BullMQ repeatable job, runs every 2 minutes)');

  // Set up repeatable job for the snooze sweep (BullMQ)
  // Every 5 minutes: a snooze is stored as `subscribed = false` plus a date, which means it has
  // no way to end on its own -- this sweep is what resubscribes the contact. Five minutes is far
  // finer than a window measured in weeks to years, and a run with nothing due costs one indexed
  // query returning no rows.
  await snoozeSweepQueue.add(
    'sweep-expired-snoozes',
    {},
    {
      repeat: {
        pattern: '*/5 * * * *', // Every 5 minutes
      },
      jobId: 'snooze-sweep-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Snooze sweep scheduled (BullMQ repeatable job, runs every 5 minutes)');

  // Set up repeatable job for the email recovery sweep (BullMQ)
  // Every 5 minutes: an email left PENDING without a job, or SENDING after its worker stopped,
  // holds its campaign in SENDING until something settles it. A run with nothing stuck costs
  // two indexed queries returning no rows; it never sends anything.
  await emailRecoverySweepQueue.add(
    'sweep-stuck-emails',
    {},
    {
      repeat: {
        pattern: '*/5 * * * *', // Every 5 minutes
      },
      jobId: 'email-recovery-sweep-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Email recovery sweep scheduled (BullMQ repeatable job, runs every 5 minutes)');

  // Plunk Lite: every 15 minutes, whether SES events reach the webhook. One grouped query over the
  // emails of the last six hours, by the `createdAt` index; it only records and alerts.
  await plunkLiteChecksQueue.add(
    'sns-health',
    {},
    {
      repeat: {
        pattern: '*/15 * * * *', // Every 15 minutes
      },
      jobId: 'sns-health-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] SES events check scheduled (BullMQ repeatable job, runs every 15 minutes)');

  // Plunk Lite: every 15 minutes, how full Redis is against its maxmemory; once full it refuses
  // every write, queued emails included
  await plunkLiteChecksQueue.add(
    'redis-memory',
    {},
    {
      repeat: {
        pattern: '*/15 * * * *', // Every 15 minutes
      },
      jobId: 'redis-memory-repeatable', // Fixed ID to prevent duplicates
    },
  );

  signale.info('[BACKGROUND-JOB] Redis memory check scheduled (BullMQ repeatable job, runs every 15 minutes)');

  // Plunk Lite: every 5 minutes, recover the workflow runs nothing would move on any more: fail the
  // ones a restart left RUNNING, so they no longer keep their contacts out of the workflow, and end
  // or fail the ones left WAITING past the end of their wait. Few kept, so they do not crowd out the
  // other checks.
  await plunkLiteChecksQueue.add(
    'workflow-recovery',
    {},
    {
      repeat: {
        pattern: '*/5 * * * *', // Every 5 minutes
      },
      jobId: 'workflow-recovery-repeatable', // Fixed ID to prevent duplicates
      attempts: 2,
      removeOnComplete: 20,
    },
  );

  signale.info('[BACKGROUND-JOB] Workflow recovery sweep scheduled (BullMQ repeatable job, runs every 5 minutes)');
}
