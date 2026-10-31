import {prisma} from '../database/prisma.js';

/**
 * The source an email that could not be sent is reported under (Plunk Lite's failure alerts): the
 * workflow it belongs to, its campaign, or the project's transactional emails.
 */
export function failureSourceFor(email: {
  campaignId: string | null;
  campaign?: {name: string} | null;
  workflow?: {id: string; name: string} | null;
}): {sourceKey: string; label: string} {
  if (email.workflow) {
    return {sourceKey: `workflow:${email.workflow.id}`, label: email.workflow.name};
  }
  if (email.campaignId) {
    return {sourceKey: `campaign:${email.campaignId}`, label: email.campaign?.name ?? 'Campaign'};
  }
  return {sourceKey: 'transactional', label: 'Transactional emails'};
}

/**
 * The source of an email as alerts and the brakes name it, looking up the workflow its execution
 * belongs to: `workflow:<id>`, `campaign:<id>` or `transactional`
 */
export async function sourceKeyOf(email: {
  campaignId: string | null;
  campaign?: {name: string} | null;
  workflowExecutionId: string | null;
}): Promise<{sourceKey: string; label: string}> {
  const workflow = email.workflowExecutionId
    ? (
        await prisma.workflowExecution.findUnique({
          where: {id: email.workflowExecutionId},
          select: {workflow: {select: {id: true, name: true}}},
        })
      )?.workflow
    : null;
  return failureSourceFor({...email, workflow});
}
