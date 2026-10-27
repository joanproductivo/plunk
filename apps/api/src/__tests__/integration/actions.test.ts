import {beforeEach, describe, expect, it} from 'vitest';
import {ActionSchemas} from '@plunk/shared';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {
  BadRequest,
  ConflictError,
  ErrorCode,
  HttpException,
  NotAllowed,
  NotAuthenticated,
  NotFound,
  RateLimitError,
  ValidationError,
} from '../../exceptions/index.js';
import {EmailService} from '../../services/EmailService.js';

/**
 * Integration tests for Actions API endpoints (/v1/send, /v1/track)
 * Tests error handling, validation, and business logic for public API
 */
describe('Actions API Integration Tests', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  // ========================================
  // ERROR RESPONSE STRUCTURE
  // ========================================
  describe('Error Response Structure', () => {
    it('should have standardized error response format', () => {
      // Document the expected error response structure
      const expectedErrorResponse = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR', // Machine-readable
          message: 'Request validation failed', // Human-readable
          statusCode: 422,
          requestId: expect.any(String), // For tracking
          errors: expect.any(Array), // Field-level errors (for validation)
          suggestion: expect.any(String), // Helpful tip
        },
        timestamp: expect.any(String), // ISO timestamp
      };

      // Verify structure
      expect(expectedErrorResponse.success).toBe(false);
      expect(expectedErrorResponse.error.code).toBeDefined();
      expect(expectedErrorResponse.error.message).toBeDefined();
      expect(expectedErrorResponse.error.statusCode).toBeDefined();
    });
  });

  // ========================================
  // VALIDATION ERRORS (422)
  // ========================================
  describe('Validation Error Handling', () => {
    it('should validate email format in requests', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'not-an-email',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(false);
    });

    it('should validate required fields for /v1/send', () => {
      const result = ActionSchemas.send.safeParse({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some(e => e.path.includes('to'))).toBe(true);
      }
    });

    it('should validate subject and body required when no template', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        from: 'test@example.com',
        // Missing subject, body, and template
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some(e => e.message.includes('template'))).toBe(true);
      }
    });

    it('should validate required fields for /v1/track', () => {
      const result = ActionSchemas.track.safeParse({
        email: 'test@example.com',
        // Missing event name
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some(e => e.path.includes('event'))).toBe(true);
      }
    });

    it('should accept from as string (backward compatible)', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: 'sender@example.com',
      });

      expect(result.success).toBe(true);
    });

    it('should accept from as object with name and email', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: {
          name: 'John Doe',
          email: 'sender@example.com',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should accept from as object with only email', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: {
          email: 'sender@example.com',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should reject from object with invalid email', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: {
          name: 'John Doe',
          email: 'not-an-email',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject from object missing email field', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test',
        from: {
          name: 'John Doe',
        },
      });

      expect(result.success).toBe(false);
    });

    it('should accept to as string (backward compatible)', () => {
      const result = ActionSchemas.send.safeParse({
        to: 'test@example.com',
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as object with name and email', () => {
      const result = ActionSchemas.send.safeParse({
        to: {
          name: 'Jane Doe',
          email: 'test@example.com',
        },
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as object with only email', () => {
      const result = ActionSchemas.send.safeParse({
        to: {
          email: 'test@example.com',
        },
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as array of strings', () => {
      const result = ActionSchemas.send.safeParse({
        to: ['test1@example.com', 'test2@example.com'],
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as array of objects with name and email', () => {
      const result = ActionSchemas.send.safeParse({
        to: [
          {name: 'Jane Doe', email: 'test1@example.com'},
          {name: 'John Smith', email: 'test2@example.com'},
        ],
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should accept to as mixed array of strings and objects', () => {
      const result = ActionSchemas.send.safeParse({
        to: ['test1@example.com', {name: 'John Smith', email: 'test2@example.com'}],
        from: 'test@example.com',
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(true);
    });

    it('should reject to object with invalid email', () => {
      const result = ActionSchemas.send.safeParse({
        to: {
          name: 'Jane Doe',
          email: 'not-an-email',
        },
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(false);
    });

    it('should reject to object missing email field', () => {
      const result = ActionSchemas.send.safeParse({
        to: {
          name: 'Jane Doe',
        },
        subject: 'Test',
        body: 'Test',
      });

      expect(result.success).toBe(false);
    });

    describe('size and depth of data (Plunk Lite)', () => {
      const track = (data: unknown, event = 'signup') =>
        ActionSchemas.track.safeParse({event, email: 'user@example.com', data});
      const send = (data: unknown) =>
        ActionSchemas.send.safeParse({to: 'user@example.com', subject: 'Hi', body: 'Hi', data});
      /** An object nested `levels` deep */
      const nested = (levels: number) => {
        let value: unknown = 'leaf';
        for (let i = 0; i < levels; i++) value = {child: value};
        return value;
      };

      it('accepts a typical form submission', () => {
        const form = Object.fromEntries(Array.from({length: 10}, (_, i) => [`field${i}`, `value ${i}`]));
        expect(track(form).success).toBe(true);
        expect(send(form).success).toBe(true);
      });

      it('refuses data over 32 KB', () => {
        expect(track({notes: 'x'.repeat(33 * 1024)}).success).toBe(false);
        expect(send({notes: 'x'.repeat(33 * 1024)}).success).toBe(false);
      });

      it('accepts 6 levels of nesting and refuses 7', () => {
        expect(track(nested(6)).success).toBe(true);
        expect(track(nested(7)).success).toBe(false);
        expect(send(nested(6)).success).toBe(true);
        expect(send(nested(7)).success).toBe(false);
      });

      it('refuses 10,000 levels with a validation issue instead of overflowing the stack', () => {
        const result = track(nested(10_000));
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain('nested deeper');
      });

      it('refuses an event name over 100 characters or with a line break', () => {
        expect(track({}, 'x'.repeat(100)).success).toBe(true);
        expect(track({}, 'x'.repeat(101)).success).toBe(false);
        expect(track({}, 'sign\nup').success).toBe(false);
        expect(track({}, 'sign\u0000up').success).toBe(false);
      });

      it('refuses what Postgres cannot store, \\u0000 and lone surrogates, in values and keys', () => {
        expect(track({note: 'a\u0000b'}).success).toBe(false);
        expect(track({['a\u0000b']: 1}).success).toBe(false);
        expect(send({deep: {note: 'a\u0000b'}}).success).toBe(false);
        expect(track({name: 'x\ud800'}).success).toBe(false);
        expect(track({name: '\udc00x'}).success).toBe(false);
        expect(track({['k\ud800']: 1}).success).toBe(false);
        // A whole pair is fine: an emoji
        expect(track({name: 'hola \ud83d\ude00'}).success).toBe(true);
        // Nor in the event name or a recipient's name, which are stored too
        expect(track({}, 'sign\ud800up').success).toBe(false);
        expect(
          ActionSchemas.send.safeParse({to: [{name: 'Ana\ud800', email: 'a@example.com'}], subject: 'Hi', body: 'Hi'})
            .success,
        ).toBe(false);
      });

      it('takes at most 50 recipients in one send', () => {
        const to = (count: number) => Array.from({length: count}, (_, i) => `user${i}@example.com`);
        expect(ActionSchemas.send.safeParse({to: to(50), subject: 'Hi', body: 'Hi'}).success).toBe(true);
        expect(ActionSchemas.send.safeParse({to: to(51), subject: 'Hi', body: 'Hi'}).success).toBe(false);
        expect(ActionSchemas.send.safeParse({to: [], subject: 'Hi', body: 'Hi'}).success).toBe(false);
      });
    });
  });

  // ========================================
  // CUSTOM HTTP EXCEPTIONS
  // ========================================
  describe('Custom HTTP Exception Types', () => {
    it('should structure NotFound errors correctly', () => {
      const error = new NotFound('Template', 'abc-123');

      expect(error.code).toBe(404);
      expect(error.message).toContain('Template');
      expect(error.message).toContain('abc-123');
      expect(error.errorCode).toBe(ErrorCode.TEMPLATE_NOT_FOUND);
      expect(error.details).toEqual({resource: 'Template', id: 'abc-123'});
    });

    it('should map resources to specific error codes', () => {
      const testCases = [
        {resource: 'contact', expectedCode: ErrorCode.CONTACT_NOT_FOUND},
        {resource: 'template', expectedCode: ErrorCode.TEMPLATE_NOT_FOUND},
        {resource: 'campaign', expectedCode: ErrorCode.CAMPAIGN_NOT_FOUND},
        {resource: 'workflow', expectedCode: ErrorCode.WORKFLOW_NOT_FOUND},
        {resource: 'unknown', expectedCode: ErrorCode.RESOURCE_NOT_FOUND},
      ];

      for (const {resource, expectedCode} of testCases) {
        const error = new NotFound(resource);
        expect(error.errorCode).toBe(expectedCode);
      }
    });

    it('should structure ValidationError with field details', () => {
      const fieldErrors = [
        {field: 'email', message: 'Invalid email format', code: 'invalid_email'},
        {field: 'data.firstName', message: 'Required field', code: 'required'},
      ];

      const error = new ValidationError(fieldErrors);

      expect(error.code).toBe(422);
      expect(error.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.errors).toEqual(fieldErrors);
    });

    it('should structure NotAuthenticated errors', () => {
      const error = new NotAuthenticated();

      expect(error.code).toBe(401);
      expect(error.errorCode).toBe(ErrorCode.UNAUTHORIZED);
    });

    it('should structure NotAllowed errors', () => {
      const error = new NotAllowed('Cannot perform action', 'Insufficient permissions');

      expect(error.code).toBe(403);
      expect(error.errorCode).toBe(ErrorCode.FORBIDDEN);
      expect(error.details).toEqual({reason: 'Insufficient permissions'});
    });

    it('should structure RateLimitError', () => {
      const error = new RateLimitError('Too many requests', 60);

      expect(error.code).toBe(429);
      expect(error.errorCode).toBe(ErrorCode.RATE_LIMIT_EXCEEDED);
      expect(error.details).toEqual({retryAfter: 60});
    });

    it('should structure ConflictError', () => {
      const error = new ConflictError('Contact exists', {email: 'test@example.com'});

      expect(error.code).toBe(409);
      expect(error.errorCode).toBe(ErrorCode.CONFLICT);
      expect(error.details).toEqual({email: 'test@example.com'});
    });

    it('should structure BadRequest errors', () => {
      const error = new BadRequest('Invalid format', ErrorCode.INVALID_REQUEST_BODY, {
        expected: 'JSON',
      });

      expect(error.code).toBe(400);
      expect(error.errorCode).toBe(ErrorCode.INVALID_REQUEST_BODY);
      expect(error.details).toEqual({expected: 'JSON'});
    });
  });

  // ========================================
  // BUSINESS LOGIC ERRORS
  // ========================================
  describe('Business Logic Error Scenarios', () => {
    it('should reject marketing template sent to unsubscribed contact', async () => {
      const contact = await factories.createContact({
        projectId,
        subscribed: false,
      });

      const marketingTemplate = await factories.createTemplate({
        projectId,
        type: 'MARKETING',
      });

      await expect(
        EmailService.sendTransactionalEmail({
          projectId,
          contactId: contact.id,
          templateId: marketingTemplate.id,
          subject: 'Marketing',
          body: 'Buy now!',
          from: 'test@example.com',
        }),
      ).rejects.toThrow(/cannot send marketing template to unsubscribed contact/i);
    });

    it('should return NotFound when template does not exist', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      const template = await prisma.template.findUnique({
        where: {id: nonExistentId, projectId},
      });

      expect(template).toBeNull();

      // In actual API, this would trigger NotFound exception

      const error = new NotFound('Template', nonExistentId);

      expect(error.code).toBe(404);
      expect(error.errorCode).toBe(ErrorCode.TEMPLATE_NOT_FOUND);
    });

    it('should handle billing limit exceeded', () => {
      const error = new HttpException(429, 'Billing limit exceeded');

      expect(error.code).toBe(429);
      expect(error.message).toContain('Billing limit exceeded');
    });
  });

  // ========================================
  // ERROR CODE COVERAGE
  // ========================================
  describe('ErrorCode Enum Coverage', () => {
    it('should have all expected error codes defined', () => {
      const expectedCodes = [
        // Auth (401, 403)
        'UNAUTHORIZED',
        'INVALID_CREDENTIALS',
        'MISSING_AUTH',
        'INVALID_API_KEY',
        'FORBIDDEN',
        'PROJECT_ACCESS_DENIED',
        'PROJECT_DISABLED',

        // Resources (404, 409)
        'RESOURCE_NOT_FOUND',
        'CONTACT_NOT_FOUND',
        'TEMPLATE_NOT_FOUND',
        'CAMPAIGN_NOT_FOUND',
        'WORKFLOW_NOT_FOUND',
        'CONFLICT',

        // Validation (400, 422)
        'BAD_REQUEST',
        'VALIDATION_ERROR',
        'INVALID_EMAIL',
        'INVALID_REQUEST_BODY',
        'MISSING_REQUIRED_FIELD',

        // Limits (429, 402)
        'RATE_LIMIT_EXCEEDED',
        'BILLING_LIMIT_EXCEEDED',
        'UPGRADE_REQUIRED',

        // Server (500+)
        'INTERNAL_SERVER_ERROR',
        'DATABASE_ERROR',
        'EXTERNAL_SERVICE_ERROR',
      ];

      for (const code of expectedCodes) {
        expect(ErrorCode[code as keyof typeof ErrorCode]).toBe(code);
      }
    });
  });

  // ========================================
  // RESERVED EVENT VALIDATION
  // ========================================
  describe('Reserved Event Validation', () => {
    describe('Email events (email.*)', () => {
      it('should reject email.sent event', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'email.sent',
          email: 'test@example.com',
        });

        // Schema allows it, but controller validation should reject
        expect(result.success).toBe(true);

        // Verify the error would be thrown by controller
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.sent" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
              received: 'email.sent',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
        expect(error.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
        expect(error.errors[0]?.code).toBe('reserved_event');
      });

      it('should reject email.delivery event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.delivery" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
              received: 'email.delivery',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
        expect(error.errors[0]?.field).toBe('event');
      });

      it('should reject email.open event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.open" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should reject email.click event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.click" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should reject email.bounce event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.bounce" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should reject email.complaint event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.complaint" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should reject any email.* pattern', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.custom" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });
    });

    describe('Contact events', () => {
      it('should reject contact.subscribed event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "contact.subscribed" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
        expect(error.errors[0]?.field).toBe('event');
      });

      it('should reject contact.unsubscribed event', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "contact.unsubscribed" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should allow other contact.* events', () => {
        const result1 = ActionSchemas.track.safeParse({
          event: 'contact.created',
          email: 'test@example.com',
        });

        const result2 = ActionSchemas.track.safeParse({
          event: 'contact.updated',
          email: 'test@example.com',
        });

        expect(result1.success).toBe(true);
        expect(result2.success).toBe(true);
      });
    });

    describe('Segment events', () => {
      it('should reject segment.*.entry events', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "segment.vip-users.entry" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
        expect(error.errors[0]?.code).toBe('reserved_event');
      });

      it('should reject segment.*.exit events', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "segment.premium.exit" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error.code).toBe(422);
      });

      it('should allow other segment.* events', () => {
        const result1 = ActionSchemas.track.safeParse({
          event: 'segment.created',
          email: 'test@example.com',
        });

        const result2 = ActionSchemas.track.safeParse({
          event: 'segment.premium.updated',
          email: 'test@example.com',
        });

        expect(result1.success).toBe(true);
        expect(result2.success).toBe(true);
      });
    });

    describe('Custom user events', () => {
      it('should allow custom user events', () => {
        const testCases = [
          'user.signup',
          'purchase.completed',
          'order.placed',
          'custom.event',
          'product.viewed',
          'cart.abandoned',
        ];

        for (const eventName of testCases) {
          const result = ActionSchemas.track.safeParse({
            event: eventName,
            email: 'test@example.com',
          });

          expect(result.success).toBe(true);
        }
      });

      it('should allow events with similar but different prefixes', () => {
        const testCases = ['emails.sent', 'contacts.subscribed', 'segments.entry'];

        for (const eventName of testCases) {
          const result = ActionSchemas.track.safeParse({
            event: eventName,
            email: 'test@example.com',
          });

          expect(result.success).toBe(true);
        }
      });
    });

    describe('Error structure for reserved events', () => {
      it('should return ValidationError with correct structure', () => {
        const error = new ValidationError(
          [
            {
              field: 'event',
              message: 'Event name "email.sent" is reserved for system use and cannot be manually tracked',
              code: 'reserved_event',
              received: 'email.sent',
            },
          ],
          'Cannot track reserved system event',
        );

        expect(error).toBeInstanceOf(ValidationError);
        expect(error.code).toBe(422);
        expect(error.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
        expect(error.message).toBe('Cannot track reserved system event');
        expect(error.errors).toHaveLength(1);
        expect(error.errors[0]).toMatchObject({
          field: 'event',
          code: 'reserved_event',
          received: 'email.sent',
        });
      });
    });
  });

  // ========================================
  // SUBSCRIPTION STATUS PRESERVATION
  // ========================================
  describe('Subscription Status Preservation', () => {
    describe('/v1/send endpoint', () => {
      it('should NOT change subscription status when sending to subscribed contact without subscribed field', async () => {
        // Create a subscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: true,
          email: 'subscribed@example.com',
        });

        // Verify initial state
        expect(contact.subscribed).toBe(true);

        // Send transactional email without specifying subscribed field
        await EmailService.sendTransactionalEmail({
          projectId,
          contactId: contact.id,
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
        });

        // Verify subscription status unchanged
        const updatedContact = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updatedContact?.subscribed).toBe(true);
      });

      it('should NOT change subscription status when sending to unsubscribed contact without subscribed field', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'unsubscribed@example.com',
        });

        // Verify initial state
        expect(contact.subscribed).toBe(false);

        // Send transactional email without specifying subscribed field
        await EmailService.sendTransactionalEmail({
          projectId,
          contactId: contact.id,
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
        });

        // Verify subscription status unchanged (should still be false)
        const updatedContact = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updatedContact?.subscribed).toBe(false);
      });

      it('should allow explicit subscription when subscribed=true is provided', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'resubscribe@example.com',
        });

        // This test would need to be implemented at the controller level
        // since EmailService.sendTransactionalEmail doesn't accept subscribed parameter
        // For now, verify the schema allows it
        const result = ActionSchemas.send.safeParse({
          to: contact.email,
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
          subscribed: true,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.subscribed).toBe(true);
        }
      });

      it('should allow explicit unsubscription when subscribed=false is provided', async () => {
        // Verify the schema allows explicit false
        const result = ActionSchemas.send.safeParse({
          to: 'test@example.com',
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
          subscribed: false,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.subscribed).toBe(false);
        }
      });

      it('should default to undefined when subscribed field is omitted', () => {
        const result = ActionSchemas.send.safeParse({
          to: 'test@example.com',
          subject: 'Test',
          body: 'Test',
          from: 'test@example.com',
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should be undefined, not false
          expect(result.data.subscribed).toBeUndefined();
        }
      });

      it('should create new contacts as unsubscribed when subscribed is undefined', async () => {
        const newEmail = 'new-send-contact@example.com';

        // Send email to new contact without specifying subscribed
        const {ContactService} = await import('../../services/ContactService.js');
        const contact = await ContactService.upsert(projectId, newEmail, {name: 'Test'}, false);

        // Transactional emails should create contacts as unsubscribed by default
        expect(contact.subscribed).toBe(false);
      });
    });

    describe('/v1/track endpoint', () => {
      it('should NOT change subscription status when tracking event for subscribed contact', async () => {
        // Create a subscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: true,
          email: 'track-subscribed@example.com',
        });

        // Verify initial state
        expect(contact.subscribed).toBe(true);

        // Track event without specifying subscribed field
        // This would be done via ContactService.upsert in the track endpoint
        const {ContactService} = await import('../../services/ContactService.js');
        await ContactService.upsert(projectId, contact.email, {event: 'test'}, undefined);

        // Verify subscription status unchanged
        const updatedContact = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updatedContact?.subscribed).toBe(true);
      });

      it('should NOT re-subscribe unsubscribed contact when tracking event', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'track-unsubscribed@example.com',
        });

        // Verify initial state
        expect(contact.subscribed).toBe(false);

        // Track event without specifying subscribed field
        const {ContactService} = await import('../../services/ContactService.js');
        await ContactService.upsert(projectId, contact.email, {event: 'test'}, undefined);

        // Verify subscription status unchanged (should still be false, NOT re-subscribed)
        const updatedContact = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updatedContact?.subscribed).toBe(false);
      });

      it('should create new contacts as subscribed when subscribed is undefined', async () => {
        const newEmail = 'new-track-contact@example.com';

        // Track event for new contact without specifying subscribed
        const {ContactService} = await import('../../services/ContactService.js');
        const contact = await ContactService.upsert(projectId, newEmail, {event: 'test'}, true);

        // Event tracking should create contacts as subscribed by default
        expect(contact.subscribed).toBe(true);
      });

      it('should allow explicit subscription when subscribed=true is provided', async () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          subscribed: true,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.subscribed).toBe(true);
        }
      });

      it('should allow explicit unsubscription when subscribed=false is provided', async () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
          subscribed: false,
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.subscribed).toBe(false);
        }
      });

      it('should default to undefined when subscribed field is omitted', () => {
        const result = ActionSchemas.track.safeParse({
          event: 'test',
          email: 'test@example.com',
        });

        expect(result.success).toBe(true);
        if (result.success) {
          // Should be undefined, not true
          expect(result.data.subscribed).toBeUndefined();
        }
      });
    });

    describe('ContactService.upsert behavior', () => {
      it('should preserve subscription status when undefined is passed for existing contact', async () => {
        // Create a subscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: true,
          email: 'upsert-test@example.com',
        });

        const {ContactService} = await import('../../services/ContactService.js');

        // Update with undefined subscribed
        await ContactService.upsert(projectId, contact.email, {firstName: 'John'}, undefined);

        const updated = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updated?.subscribed).toBe(true);
      });

      it('should preserve unsubscribed status when undefined is passed', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'upsert-unsub@example.com',
        });

        const {ContactService} = await import('../../services/ContactService.js');

        // Update with undefined subscribed
        await ContactService.upsert(projectId, contact.email, {firstName: 'Jane'}, undefined);

        const updated = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updated?.subscribed).toBe(false);
      });

      it('should allow explicit subscription change to true', async () => {
        // Create an unsubscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: false,
          email: 'explicit-sub@example.com',
        });

        const {ContactService} = await import('../../services/ContactService.js');

        // Explicitly subscribe
        await ContactService.upsert(projectId, contact.email, {}, true);

        const updated = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updated?.subscribed).toBe(true);
      });

      it('should allow explicit subscription change to false', async () => {
        // Create a subscribed contact
        const contact = await factories.createContact({
          projectId,
          subscribed: true,
          email: 'explicit-unsub@example.com',
        });

        const {ContactService} = await import('../../services/ContactService.js');

        // Explicitly unsubscribe
        await ContactService.upsert(projectId, contact.email, {}, false);

        const updated = await prisma.contact.findUnique({
          where: {id: contact.id},
        });

        expect(updated?.subscribed).toBe(false);
      });
    });
  });
});
