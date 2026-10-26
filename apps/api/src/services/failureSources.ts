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
