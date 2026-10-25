import {beforeEach, describe, expect, it, vi} from 'vitest';

import {CampaignService} from '../CampaignService';
import {sendRawEmail} from '../SESService';
import {factories} from '../../../../../test/helpers';

vi.mock('../SESService', () => ({
  sendRawEmail: vi.fn(),
}));

describe('CampaignService - sendTest', () => {
  let projectId: string;
  let memberEmail: string;

  beforeEach(async () => {
    const {user, project} = await factories.createUserWithProject();
    projectId = project.id;
    memberEmail = user.email;

    await factories.createDomain({projectId, domain: 'example.com', verified: true});
    vi.mocked(sendRawEmail).mockResolvedValue({messageId: 'ses-message-123'});
  });

  it('styles visual editor content the same way a real send does', async () => {
    const campaign = await factories.createCampaign({projectId, body: '<p>Hello {{name}}</p>'});

    await CampaignService.sendTest(projectId, campaign.id, memberEmail);

    const html = vi.mocked(sendRawEmail).mock.calls[0]?.[0].content.html ?? '';
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toMatch(/<p style="[^"]*margin-top/);
    // Test sends have no contact, so variables stay unrendered
    expect(html).toContain('Hello {{name}}');
  });

  it('sends custom HTML untouched', async () => {
    const body = '<table><tr><td>Custom</td></tr></table>';
    const campaign = await factories.createCampaign({projectId, body});

    await CampaignService.sendTest(projectId, campaign.id, memberEmail);

    expect(vi.mocked(sendRawEmail).mock.calls[0]?.[0].content.html).toBe(body);
  });
});
