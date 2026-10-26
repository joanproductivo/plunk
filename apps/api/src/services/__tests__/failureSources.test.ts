import {describe, expect, it} from 'vitest';

import {failureSourceFor} from '../failureSources';

describe('failureSourceFor', () => {
  it("reports a workflow's email under the workflow", () => {
    expect(failureSourceFor({campaignId: null, workflow: {id: 'w1', name: 'Welcome'}})).toEqual({
      sourceKey: 'workflow:w1',
      label: 'Welcome',
    });
  });

  it("reports a campaign's email under the campaign", () => {
    expect(failureSourceFor({campaignId: 'c1', campaign: {name: 'October news'}})).toEqual({
      sourceKey: 'campaign:c1',
      label: 'October news',
    });
  });

  it('reports the rest as transactional emails', () => {
    expect(failureSourceFor({campaignId: null, campaign: null, workflow: null})).toEqual({
      sourceKey: 'transactional',
      label: 'Transactional emails',
    });
  });
});
