import {describe, expect, it} from 'vitest';

import {classifySesRefusal} from '../SESService';

/** An error SES answered with, named as the SDK names it */
function answered(name: string, message: string, httpStatusCode = 400) {
  return Object.assign(new Error(message), {name, $metadata: {httpStatusCode}});
}

const main = {mainConfigurationSet: true};

/** Plunk Lite: what each refusal from SES calls for */
describe('classifySesRefusal', () => {
  it('tells the sending rate from the daily quota', () => {
    expect(classifySesRefusal(answered('Throttling', 'Maximum sending rate exceeded.'), main)).toBe('rate');
    expect(classifySesRefusal(answered('Throttling', 'Daily message quota exceeded.'), main)).toBe('daily-quota');
  });

  it('takes a pause of the account, by name or by its words', () => {
    expect(classifySesRefusal(answered('AccountSendingPausedException', 'Sending is disabled'), main)).toBe(
      'account-paused',
    );
    expect(classifySesRefusal(answered('MessageRejected', 'Sending paused for this account.'), main)).toBe(
      'account-paused',
    );
  });

  it('keeps a sandbox address that is not verified a refusal of that email', () => {
    expect(
      classifySesRefusal(answered('MessageRejected', 'Email address is not verified. The following identities'), main),
    ).toBe('rejected');
    expect(classifySesRefusal(answered('MailFromDomainNotVerifiedException', 'MAIL FROM domain'), main)).toBe(
      'rejected',
    );
  });

  it('pauses for the main configuration set only', () => {
    const paused = answered('ConfigurationSetSendingPausedException', 'Sending paused for the configuration set');
    expect(classifySesRefusal(paused, {mainConfigurationSet: true})).toBe('account-paused');
    expect(classifySesRefusal(paused, {mainConfigurationSet: false})).toBe('config-set');
    expect(classifySesRefusal(answered('ConfigurationSetDoesNotExistException', 'does not exist'), main)).toBe(
      'config-set',
    );
  });

  it('leaves anything else, and anything SES did not answer, to the usual retries', () => {
    expect(classifySesRefusal(answered('InternalFailure', 'Something went wrong', 500), main)).toBe('other');
    expect(classifySesRefusal(answered('Throttling', 'Maximum sending rate exceeded.', 200), main)).toBe('other');
    expect(classifySesRefusal(Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'}), main)).toBe('other');
  });
});
