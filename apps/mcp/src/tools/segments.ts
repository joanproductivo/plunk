import * as z from 'zod';

import type {PlunkClient} from '../client.js';
import {FILTER_HELP, filterCondition} from '../schemas.js';

import {errorResult, jsonResult, register, requireConfirmation, runTool, type ToolContext} from './shared.js';

/** Most emails one call to the segment members endpoints takes */
const MAX_EMAILS = 500;

/**
 * Asks before changing the members of a segment that tracks membership: each change fires its
 * entry or exit event, and workflows started by it can send email. Undefined when no prompt is
 * needed (the segment does not track membership, or the user confirmed).
 */
async function confirmTrackedChange(
  client: PlunkClient,
  context: unknown,
  segmentId: string,
  change: {key: string; question: (name: string) => string},
) {
  const segment = await client.request<{name?: string; trackMembership?: boolean}>({path: `/segments/${segmentId}`});
  if (!segment.trackMembership) {
    return undefined;
  }

  return requireConfirmation(
    context as {mcpReq?: {inputResponses?: unknown}},
    change.key,
    `${change.question(segment.name ?? segmentId)} Workflows started by it can send email, which cannot be recalled.`,
  );
}

/** Emails as the members endpoints take them: trimmed, up to 320 characters, at most MAX_EMAILS */
const emailList = z
  .array(z.string().trim().min(1).max(320))
  .min(1)
  .max(MAX_EMAILS)
  .describe(`Up to ${MAX_EMAILS} email addresses.`);

export function registerSegmentTools(ctx: ToolContext, client: PlunkClient): void {
  register(
    ctx,
    'plunk_list_segments',
    {
      title: 'List segments',
      description: [
        '**Purpose:** List saved audience segments and their sizes.',
        '',
        '**NOT for:** Listing the contacts inside a segment — this returns the segments themselves.',
        '',
        '**Returns:** Every segment in the project, with IDs, names, types, conditions and cached member',
        'counts (`memberCount`).',
        '',
        '**When to use:** Before creating a `SEGMENT`-audience campaign, to find the segment ID and',
        'to show the user how many people it covers.',
        '',
        '**Key trigger phrases:** "what segments do I have", "my audiences", "how big is the segment"',
      ].join('\n'),
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async () =>
      runTool(async () => {
        // GET /segments returns every segment as a bare array — it is not paginated.
        const segments = await client.request<unknown[]>({path: '/segments'});

        return jsonResult(`Found ${segments.length} segment(s).`, segments);
      }),
  );

  register(
    ctx,
    'plunk_create_segment',
    {
      title: 'Create segment',
      description: [
        '**Purpose:** Create a reusable audience segment. A `DYNAMIC` segment re-evaluates its filter',
        'continuously, so contacts join and leave automatically. A `STATIC` one holds a fixed membership',
        'you manage yourself.',
        '',
        '**NOT for:** Sending anything, and not needed for a one-off audience — a campaign can carry an',
        'inline filter via `audienceType: "FILTERED"` instead. Create a segment when the audience will',
        'be reused or when the user wants to see it in the dashboard.',
        '',
        '**Returns:** The created segment including its ID.',
        '',
        FILTER_HELP,
        '',
        '**Key trigger phrases:** "create a segment", "save this audience", "group of users who"',
      ].join('\n'),
      inputSchema: z.object({
        name: z.string().max(100).describe('Segment name.'),
        description: z.string().max(500).optional().describe('Optional description.'),
        type: z.enum(['DYNAMIC', 'STATIC']).default('DYNAMIC').describe('DYNAMIC re-evaluates; STATIC is fixed.'),
        condition: z.optional(filterCondition).describe('Filter tree. Required for DYNAMIC segments.'),
        trackMembership: z
          .boolean()
          .default(false)
          .describe(
            'Emit segment.<slug>.entry / .exit events as contacts join and leave. ' +
              'These can be used as workflow triggers.',
          ),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async (input) =>
      runTool(async () => {
        if (input.type === 'DYNAMIC' && !input.condition) {
          return errorResult(
            'A DYNAMIC segment needs a `condition` filter tree. Either supply one, or use type "STATIC".',
          );
        }

        const segment = await client.request({method: 'POST', path: '/segments', body: input});
        return jsonResult('Segment created:', segment);
      }),
  );

  register(
    ctx,
    'plunk_add_to_segment',
    {
      title: 'Add contacts to a segment',
      description: [
        '**Purpose:** Add contacts to a STATIC segment by email. With `createMissing`, contacts that do',
        'not exist yet are created first.',
        '',
        '**NOT for:** DYNAMIC segments — their filter decides who is in them, and the API refuses.',
        '',
        '**Returns:** `added` (contacts that entered, including current members, who re-enter), `created`',
        '(contacts created first) and `notFound` (emails with no contact, when `createMissing` is false).',
        '',
        '**Side effects:** When the segment tracks membership, each contact added fires',
        '`segment.<slug>.entry` — also a current member, which counts as a new entry — and that can start',
        'workflows (and their emails) for them, so the user is asked to confirm first.',
        '',
        '**Key trigger phrases:** "add them to the segment", "put these people in", "tag these contacts"',
      ].join('\n'),
      inputSchema: z.object({
        segmentId: z.string().uuid().describe('ID of the STATIC segment (from plunk_list_segments).'),
        emails: emailList,
        createMissing: z
          .boolean()
          .default(false)
          .describe('Create contacts for emails that do not exist yet (subscribed unless `subscribed` is false).'),
        subscribed: z.boolean().optional().describe('With createMissing: subscription state of the created contacts.'),
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    async ({segmentId, ...body}, context) =>
      runTool(async () => {
        const pending = await confirmTrackedChange(client, context, segmentId, {
          key: 'confirm_segment_add',
          question: name =>
            `Add ${body.emails.length} contact(s) to "${name}"? It tracks membership, so each one fires its ` +
            'entry event, current members included.',
        });
        if (pending) {
          return pending;
        }

        const result = await client.request<{added: number; created: number; notFound: string[]}>({
          method: 'POST',
          path: `/segments/${segmentId}/members`,
          body,
        });

        const notFound =
          result.notFound.length > 0
            ? ` ${result.notFound.length} email(s) have no contact; pass createMissing: true to create them.`
            : '';
        return jsonResult(`Added ${result.added} contact(s); created ${result.created}.${notFound}`, result);
      }),
  );

  register(
    ctx,
    'plunk_remove_from_segment',
    {
      title: 'Remove contacts from a segment',
      description: [
        '**Purpose:** Remove contacts from a STATIC segment by email. The contacts themselves are kept.',
        '',
        '**NOT for:** DYNAMIC segments (the API refuses), or deleting contacts.',
        '',
        '**Returns:** `removed`, the contacts that were in the segment and left it. Emails with no contact,',
        'or whose contact was not in the segment, are ignored.',
        '',
        '**Side effects:** When the segment tracks membership, each contact that leaves fires',
        '`segment.<slug>.exit`, which can start workflows for them, so the user is asked to confirm first.',
        '',
        '**Key trigger phrases:** "take them out of the segment", "remove these people from"',
      ].join('\n'),
      inputSchema: z.object({
        segmentId: z.string().uuid().describe('ID of the STATIC segment (from plunk_list_segments).'),
        emails: emailList,
      }),
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({segmentId, emails}, context) =>
      runTool(async () => {
        const pending = await confirmTrackedChange(client, context, segmentId, {
          key: 'confirm_segment_remove',
          question: name =>
            `Remove ${emails.length} contact(s) from "${name}"? It tracks membership, so each member fires its ` +
            'exit event.',
        });
        if (pending) {
          return pending;
        }

        const result = await client.request<{removed: number}>({
          method: 'DELETE',
          path: `/segments/${segmentId}/members`,
          body: {emails},
        });

        return jsonResult(`Removed ${result.removed} contact(s) from the segment.`, result);
      }),
  );
}
