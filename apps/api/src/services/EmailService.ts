import type {Contact, Email, Project, TemplateType} from '@plunk/db';
import {EmailSourceType, EmailStatus, Prisma, TrackingMode} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import signale from 'signale';

import {DASHBOARD_URI, LANDING_URI, STRIPE_ENABLED, TRACKING_TOGGLE_ENABLED} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';
import {
  footerParagraph,
  type ProjectFooters,
  renderTemplate,
  resolveContactLanguage,
  unsubscribeFooterHtml,
} from '@plunk/shared';

import {renderBody} from '../utils/emailBody.js';

import {BillingLimitService} from './BillingLimitService.js';
import {RECIPIENT_OVERRIDE_HEADER, withSourceEmail} from './EmailHeaderService.js';
import {ProjectService} from './ProjectService.js';
import {QueueService} from './QueueService.js';

interface Attachment {
  filename: string;
  content: string; // Base64 encoded
  contentType: string;
  contentId?: string;
  disposition?: 'attachment' | 'inline';
}

interface SendEmailParams {
  /** A fixed id for the row (campaign emails): creating it a second time returns the first */
  id?: string;
  projectId: string;
  contactId: string;
  subject: string;
  body: string;
  from: string;
  fromName?: string;
  toName?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: Attachment[];
  templateId?: string;
  campaignId?: string;
  workflowExecutionId?: string;
  workflowStepExecutionId?: string;
  recipientEmail?: string; // Optional custom recipient email (overrides contact.email)
  isTransactional?: boolean; // Override source type to TRANSACTIONAL (e.g. for transactional campaigns)
}

/** A create that collided with an existing row's primary key */
function isIdConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes('id') : String(target).endsWith('_pkey');
}

/**
 * Email Service
 * Builds and queues outbound email. The send itself is jobs/email-processor.ts, and the SES
 * events that follow it are handled by controllers/Webhooks.ts.
 */
export class EmailService {
  /**
   * Whether an email may only go to a subscribed contact.
   *
   * Decided when the email is queued and again by the send path just before it leaves: a
   * contact can unsubscribe, bounce or complain in between, and a large campaign takes an hour
   * to drain at 14/s.
   *
   * - Campaign and workflow emails are marketing. A transactional template makes their source
   *   type TRANSACTIONAL, as does a transactional campaign.
   * - A transactional send with a MARKETING template is still marketing.
   * - A workflow email to a custom recipient goes to an address outside the contact list.
   */
  public static requiresSubscribedContact(params: {
    sourceType: EmailSourceType;
    templateType?: TemplateType | null;
    hasRecipientOverride: boolean;
  }): boolean {
    if (params.hasRecipientOverride) {
      return false;
    }

    if (params.sourceType !== EmailSourceType.TRANSACTIONAL) {
      return true;
    }

    return params.templateType === 'MARKETING';
  }

  /**
   * Send a transactional email via API
   */
  public static async sendTransactionalEmail(params: SendEmailParams): Promise<Email> {
    // Check if a template is used and if it's a marketing template
    // Marketing templates should not be sent to unsubscribed contacts even via the transactional API
    if (params.templateId) {
      const template = await prisma.template.findUnique({
        where: {id: params.templateId},
        select: {type: true},
      });

      // If using a marketing template, check subscription status
      if (
        this.requiresSubscribedContact({
          sourceType: EmailSourceType.TRANSACTIONAL,
          templateType: template?.type,
          hasRecipientOverride: false,
        })
      ) {
        const contact = await prisma.contact.findUnique({
          where: {id: params.contactId},
          select: {subscribed: true, email: true},
        });

        if (!contact?.subscribed) {
          throw new HttpException(
            400,
            `Cannot send marketing template to unsubscribed contact ${contact?.email || params.contactId}. Use a transactional template or send without a template.`,
          );
        }
      }
    }

    // Check billing limit before sending
    const limitCheck = await BillingLimitService.checkLimit(params.projectId, EmailSourceType.TRANSACTIONAL);

    if (!limitCheck.allowed) {
      throw new HttpException(429, limitCheck.message || 'Billing limit exceeded for transactional emails');
    }

    // Log warning if approaching limit (80%)
    if (limitCheck.warning) {
      signale.warn(`[BILLING_LIMIT] ${limitCheck.message}`);
    }

    const email = await prisma.email.create({
      data: {
        projectId: params.projectId,
        contactId: params.contactId,
        subject: params.subject,
        body: params.body,
        from: params.from,
        fromName: params.fromName,
        toName: params.toName,
        replyTo: params.replyTo,
        headers: params.headers ? toPrismaJson(params.headers) : undefined,
        attachments: params.attachments ? toPrismaJson(params.attachments) : undefined,
        sourceType: EmailSourceType.TRANSACTIONAL,
        templateId: params.templateId,
        status: EmailStatus.PENDING,
      },
    });

    // Increment usage counter in cache
    await BillingLimitService.incrementUsage(params.projectId, EmailSourceType.TRANSACTIONAL);

    // Queue email for sending
    await this.queueEmail(email.id, EmailSourceType.TRANSACTIONAL);

    return email;
  }

  /**
   * Send a campaign email
   */
  public static async sendCampaignEmail(params: SendEmailParams): Promise<Email> {
    // Check if campaign or template is transactional to determine source type
    let sourceType: EmailSourceType = EmailSourceType.CAMPAIGN;

    if (params.isTransactional) {
      sourceType = EmailSourceType.TRANSACTIONAL;
    } else if (params.templateId) {
      const template = await prisma.template.findUnique({
        where: {id: params.templateId},
        select: {type: true},
      });

      // If template is marked as TRANSACTIONAL, use TRANSACTIONAL sourceType
      // This ensures unsubscribe footer is not added to transactional emails
      if (template?.type === 'TRANSACTIONAL') {
        sourceType = EmailSourceType.TRANSACTIONAL;
      }
    }

    // Check billing limit before sending
    const limitCheck = await BillingLimitService.checkLimit(params.projectId, sourceType);

    if (!limitCheck.allowed) {
      throw new HttpException(
        429,
        limitCheck.message || `Billing limit exceeded for ${sourceType.toLowerCase()} emails`,
      );
    }

    // Log warning if approaching limit (80%)
    if (limitCheck.warning) {
      signale.warn(`[BILLING_LIMIT] ${limitCheck.message}`);
    }

    let email: Email;
    try {
      email = await prisma.email.create({
        data: {
          id: params.id,
          projectId: params.projectId,
          contactId: params.contactId,
          subject: params.subject,
          body: params.body,
          from: params.from,
          fromName: params.fromName,
          replyTo: params.replyTo,
          headers: params.headers ? toPrismaJson(params.headers) : undefined,
          attachments: params.attachments ? toPrismaJson(params.attachments) : undefined,
          sourceType,
          templateId: params.templateId,
          campaignId: params.campaignId,
          status: EmailStatus.PENDING,
        },
      });
    } catch (error) {
      const existing = params.id && isIdConflict(error) ? await prisma.email.findUnique({where: {id: params.id}}) : null;
      if (!existing) {
        throw error;
      }

      // An earlier run of the same batch created this email. It is not created or counted
      // again; if it was never sent, it is queued again, because that run may have died
      // before queueing it (the job id is the email's, so a job that exists is not doubled).
      if (existing.status === EmailStatus.PENDING) {
        await this.queueEmail(existing.id, existing.sourceType);
      }
      return existing;
    }

    // Increment usage counter in cache
    await BillingLimitService.incrementUsage(params.projectId, sourceType);

    // Queue email for sending
    await this.queueEmail(email.id, sourceType);

    return email;
  }

  /**
   * Send a workflow email
   */
  public static async sendWorkflowEmail(params: SendEmailParams): Promise<Email> {
    // Check if template is transactional to determine source type
    let sourceType: EmailSourceType = EmailSourceType.WORKFLOW;

    if (params.templateId) {
      const template = await prisma.template.findUnique({
        where: {id: params.templateId},
        select: {type: true},
      });

      // If template is marked as TRANSACTIONAL, use TRANSACTIONAL sourceType
      // This ensures unsubscribe footer is not added to transactional emails
      if (template?.type === 'TRANSACTIONAL') {
        sourceType = EmailSourceType.TRANSACTIONAL;
      }
    }

    // Check subscription status for marketing emails
    // Transactional emails should always be sent regardless of subscription status
    // Custom recipient emails also bypass subscription checks (they're not in the contact list)
    if (this.requiresSubscribedContact({sourceType, hasRecipientOverride: Boolean(params.recipientEmail)})) {
      const contact = await prisma.contact.findUnique({
        where: {id: params.contactId},
        select: {subscribed: true},
      });

      if (!contact?.subscribed) {
        signale.info(
          `[WORKFLOW] Skipping marketing email to unsubscribed contact ${params.contactId} in workflow execution ${params.workflowExecutionId}`,
        );
        // For workflows, we silently skip sending to unsubscribed contacts for marketing emails
        // Return a placeholder email record that won't be sent
        return await prisma.email.create({
          data: {
            projectId: params.projectId,
            contactId: params.contactId,
            subject: params.subject,
            body: params.body,
            from: params.from,
            fromName: params.fromName,
            replyTo: params.replyTo,
            headers: params.headers ? toPrismaJson(params.headers) : undefined,
            attachments: params.attachments ? toPrismaJson(params.attachments) : undefined,
            sourceType,
            templateId: params.templateId,
            workflowExecutionId: params.workflowExecutionId,
            workflowStepExecutionId: params.workflowStepExecutionId,
            status: EmailStatus.FAILED,
            error: 'Contact is unsubscribed from marketing emails',
          },
        });
      }
    }

    // Check billing limit before sending
    const limitCheck = await BillingLimitService.checkLimit(params.projectId, sourceType);

    if (!limitCheck.allowed) {
      throw new HttpException(
        429,
        limitCheck.message || `Billing limit exceeded for ${sourceType.toLowerCase()} emails`,
      );
    }

    // Log warning if approaching limit (80%)
    if (limitCheck.warning) {
      signale.warn(`[BILLING_LIMIT] ${limitCheck.message}`);
    }

    // If custom recipient email is provided, store it in headers for later use
    const emailHeaders = params.headers ? {...params.headers} : {};
    if (params.recipientEmail) {
      emailHeaders[RECIPIENT_OVERRIDE_HEADER] = params.recipientEmail;
    }

    const email = await prisma.email.create({
      data: {
        projectId: params.projectId,
        contactId: params.contactId,
        subject: params.subject,
        body: params.body,
        from: params.from,
        fromName: params.fromName,
        replyTo: params.replyTo,
        headers: Object.keys(emailHeaders).length > 0 ? toPrismaJson(emailHeaders) : undefined,
        attachments: params.attachments ? toPrismaJson(params.attachments) : undefined,
        sourceType,
        templateId: params.templateId,
        workflowExecutionId: params.workflowExecutionId,
        workflowStepExecutionId: params.workflowStepExecutionId,
        status: EmailStatus.PENDING,
      },
    });

    // Increment usage counter in cache
    await BillingLimitService.incrementUsage(params.projectId, sourceType);

    // Queue email for sending
    await this.queueEmail(email.id, sourceType);

    return email;
  }

  /**
   * Render a single email's subject and body.
   *
   * Uses the shared Liquid renderer from @plunk/shared, which caches parsed templates,
   * so the per-email call sites here don't re-parse the same body for every recipient.
   * When rendering a known template for many contacts in one pass, prefer
   * `compileTemplate` to hoist the parse out of the loop entirely (see CampaignService).
   */
  public static format({subject, body, data}: {subject: string; body: string; data: Record<string, unknown>}): {
    subject: string;
    body: string;
  } {
    return {
      subject: renderTemplate(subject, data),
      body: renderTemplate(body, data),
    };
  }

  /**
   * Determine if an email should be tracked based on project tracking mode and email source type
   */
  public static shouldTrackEmail(trackingMode: TrackingMode, sourceType: EmailSourceType): boolean {
    switch (trackingMode) {
      case TrackingMode.ENABLED:
        return true;
      case TrackingMode.DISABLED:
        return false;
      case TrackingMode.MARKETING_ONLY:
        // Track only campaigns and workflows (marketing), not transactional emails
        return sourceType !== EmailSourceType.TRANSACTIONAL;
      default:
        return true;
    }
  }

  /**
   * The outbound streams sent with open and click tracking under a tracking mode, so stats
   * measure opens and clicks only against emails that could record them. Mirrors
   * SESService: without a no-tracking configuration set every email goes out tracked.
   */
  public static trackedSourceTypes(
    trackingMode: TrackingMode,
    toggleEnabled: boolean = TRACKING_TOGGLE_ENABLED,
  ): EmailSourceType[] {
    const outbound = Object.values(EmailSourceType).filter(type => type !== EmailSourceType.INBOUND);
    return toggleEnabled ? outbound.filter(type => this.shouldTrackEmail(trackingMode, type)) : outbound;
  }

  /**
   * The tracked streams of a project under its current tracking mode. A project that cannot
   * be found or read counts as tracking everything, the default mode, so stats still load.
   */
  public static async trackedStreams(projectId: string): Promise<EmailSourceType[]> {
    try {
      const project = await ProjectService.id(projectId);
      return this.trackedSourceTypes(project?.tracking ?? TrackingMode.ENABLED);
    } catch (error) {
      signale.warn('[EMAIL] Failed to read the tracking mode, measuring stats as if everything is tracked:', error);
      return this.trackedSourceTypes(TrackingMode.ENABLED);
    }
  }

  /**
   * Compile HTML email with optional unsubscribe footer and badge
   * Adds unsubscribe link and Plunk badge for free tier users (only when billing is enabled)
   */
  public static compile({
    content,
    contact,
    project,
    includeUnsubscribe = true,
    sourceEmailId,
    footers,
  }: {
    content: string;
    contact: Contact;
    project: Project;
    includeUnsubscribe?: boolean;
    /** The project's own footers by language (ProjectFooterService); Plunk's for the rest. */
    footers?: ProjectFooters;
    /**
     * Id of the email this footer is being rendered into, so an opt-out from the
     * footer link can be attributed to it. See {@link withSourceEmail}.
     */
    sourceEmailId?: string;
  }): string {
    const unsubscribeHtml = includeUnsubscribe
      ? (() => {
          // The contact's language (their locale, else the project's), with its own footer or Plunk's
          const locale =
            contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)
              ? (contact.data as Record<string, unknown>).locale
              : undefined;

          return unsubscribeFooterHtml(
            footerParagraph({
              language: resolveContactLanguage(locale, project.language),
              projectName: project.name,
              href: withSourceEmail(`${DASHBOARD_URI}/unsubscribe/${contact.id}`, sourceEmailId),
              footers,
            }),
          );
        })()
      : '';

    // Add Plunk badge if billing is enabled and project has no subscription (free tier)
    const badgeHtml =
      STRIPE_ENABLED && project.subscription === null
        ? `<table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;">
          <tbody>
            <tr>
              <td style="direction:ltr;font-size:0px;padding:20px 0;text-align:center;">
                <div class="mj-column-per-100 mj-outlook-group-fix" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;">
                  <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="vertical-align:top;" width="100%">
                    <tbody>
                      <tr>
                        <td align="center" style="font-size:0px;padding:10px 25px;word-break:break-word;">
                          <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;border-spacing:0px;">
                            <tbody>
                              <tr>
                                <td style="width:180px;">
                                  <a href="${LANDING_URI}?ref=badge" target="_blank">
                                    <img alt="Powered by Plunk" height="auto" src="https://cdn.useplunk.com/badge.png" style="border:0;display:block;outline:none;text-decoration:none;height:auto;width:100%;font-size:13px;" width="180" />
                                  </a>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </td>
            </tr>
          </tbody>
        </table>`
        : '';

    // The footer and badge go at the end of the email, on its background if it has one
    return renderBody(content, sourceEmailId, `${unsubscribeHtml}${badgeHtml}`);
  }

  /**
   * Queue an email for sending
   * Adds email to the BullMQ queue for processing by workers
   */
  private static async queueEmail(emailId: string, sourceType: EmailSourceType, delay?: number): Promise<void> {
    await QueueService.queueEmail(emailId, sourceType, delay);
  }
}
