import http from 'node:http';
import type {AddressInfo} from 'node:net';

import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

type SESServiceModule = typeof import('../SESService');

/**
 * The send client against a local server standing in for SES, with the real SDK: whether a
 * failed send may be retried depends on the exact shape of the errors the SDK throws, which a
 * mocked `sendRawEmail` cannot show.
 */
describe('sendRawEmail against an SES endpoint', () => {
  let server: http.Server;
  let requests = 0;
  let lastRequestBody = '';
  let respond: (res: http.ServerResponse) => void = () => {};
  const previousEndpoint = process.env.AWS_ENDPOINT_URL_SES;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests++;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        lastRequestBody = Buffer.concat(chunks).toString();
        respond(res);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousEndpoint === undefined) {
      delete process.env.AWS_ENDPOINT_URL_SES;
    } else {
      process.env.AWS_ENDPOINT_URL_SES = previousEndpoint;
    }
  });

  afterEach(() => {
    requests = 0;
  });

  /** The module built against `endpoint`: the clients read it when they are created */
  async function sesServiceAt(endpoint: string): Promise<SESServiceModule> {
    process.env.AWS_ENDPOINT_URL_SES = endpoint;
    vi.resetModules();
    return import('../SESService');
  }

  const local = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const send = (service: SESServiceModule) =>
    service.sendRawEmail({
      from: {name: 'Plunk', email: 'hello@plunk.test'},
      to: ['someone@plunk.test'],
      content: {subject: 'Hello', html: '<p>Hello</p>'},
    });

  async function failureOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('Expected the send to fail');
  }

  it('returns the message id SES answers with', async () => {
    respond = res => {
      res.writeHead(200, {'Content-Type': 'text/xml'});
      res.end(
        '<SendRawEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendRawEmailResult>' +
          '<MessageId>ses-message-1</MessageId></SendRawEmailResult><ResponseMetadata><RequestId>r-1</RequestId>' +
          '</ResponseMetadata></SendRawEmailResponse>',
      );
    };
    const service = await sesServiceAt(local());

    expect(await send(service)).toEqual({messageId: 'ses-message-1'});
  });

  it('sends the message tags, with what SES does not allow in a value replaced', async () => {
    respond = res => {
      res.writeHead(200, {'Content-Type': 'text/xml'});
      res.end(
        '<SendRawEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendRawEmailResult>' +
          '<MessageId>ses-message-2</MessageId></SendRawEmailResult><ResponseMetadata><RequestId>r-2</RequestId>' +
          '</ResponseMetadata></SendRawEmailResponse>',
      );
    };
    const service = await sesServiceAt(local());

    await service.sendRawEmail({
      from: {name: 'Plunk', email: 'hello@plunk.test'},
      to: ['someone@plunk.test'],
      content: {subject: 'Hello', html: '<p>Hello</p>'},
      tags: {emailId: '0b6b7a2e-1c3d-5e4f-8a9b-0c1d2e3f4a5b', projectId: 'project.1 ', kind: 'email'},
    });

    const tags = Object.fromEntries(
      [...new URLSearchParams(lastRequestBody)].filter(([name]) => name.startsWith('Tags.member.')),
    );
    expect(tags).toEqual({
      'Tags.member.1.Name': 'plunk_email_id',
      'Tags.member.1.Value': '0b6b7a2e-1c3d-5e4f-8a9b-0c1d2e3f4a5b',
      'Tags.member.2.Name': 'plunk_project_id',
      'Tags.member.2.Value': 'project_1_',
      'Tags.member.3.Name': 'plunk_kind',
      'Tags.member.3.Value': 'email',
    });
  });

  it('does not retry, nor mark safe to retry, an accepted send whose answer was cut off', async () => {
    respond = res => {
      // SES accepted it: the status line went out, then the connection dropped mid-body
      res.writeHead(200, {'Content-Type': 'text/xml', 'Content-Length': '500'});
      res.write('<SendRawEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendRawEm');
      res.socket?.destroy();
    };
    const service = await sesServiceAt(local());

    const error = await failureOf(send(service));

    expect(service.safeToRetrySend(error)).toBe(false);
    expect(requests).toBe(1);
  });

  it('does not mark safe to retry an accepted send whose answer cannot be parsed', async () => {
    respond = res => {
      res.writeHead(200, {'Content-Type': 'text/xml'});
      res.end('<SendRawEmailResponse><unterminated');
    };
    const service = await sesServiceAt(local());

    const error = await failureOf(send(service));

    expect(service.safeToRetrySend(error)).toBe(false);
    expect(requests).toBe(1);
  });

  it('gives up on an answer that stops arriving, without marking it safe to retry', async () => {
    // The whole-send timeout, shortened: SES accepted it and the body of its answer never ends
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(300));
    respond = res => {
      res.writeHead(200, {'Content-Type': 'text/xml', 'Content-Length': '500'});
      res.write('<SendRawEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/">');
    };
    const service = await sesServiceAt(local());

    const error = await failureOf(send(service));

    expect(service.safeToRetrySend(error)).toBe(false);
    expect(requests).toBe(1);
    vi.restoreAllMocks();
  });

  it('leaves a throttled send to the caller to retry, without retrying it itself', async () => {
    respond = res => {
      res.writeHead(400, {'Content-Type': 'text/xml'});
      res.end(
        '<ErrorResponse><Error><Type>Sender</Type><Code>Throttling</Code>' +
          '<Message>Maximum sending rate exceeded.</Message></Error><RequestId>r-2</RequestId></ErrorResponse>',
      );
    };
    const service = await sesServiceAt(local());

    const error = await failureOf(send(service));

    expect(service.safeToRetrySend(error)).toBe(true);
    // The SDK would retry a throttle three times on its own; the send client makes one attempt
    expect(requests).toBe(1);
  });

  it('marks safe to retry a send that never reached SES', async () => {
    // A port nothing listens on: the connection is refused before anything is sent
    const closed = http.createServer();
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise(resolve => closed.close(resolve));
    const service = await sesServiceAt(`http://127.0.0.1:${port}`);

    const error = await failureOf(send(service));

    expect(service.safeToRetrySend(error)).toBe(true);
  });

  it('reads the 24-hour quota quickly, and gives null without an answer or without a figure', async () => {
    const quota = (body: string) => (res: http.ServerResponse) => {
      res.writeHead(200, {'Content-Type': 'text/xml'});
      res.end(
        '<GetSendQuotaResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><GetSendQuotaResult>' +
          body +
          '</GetSendQuotaResult><ResponseMetadata><RequestId>r-q</RequestId></ResponseMetadata></GetSendQuotaResponse>',
      );
    };
    const service = await sesServiceAt(local());

    respond = quota(
      '<Max24HourSend>50000.0</Max24HourSend><SentLast24Hours>120.0</SentLast24Hours><MaxSendRate>14.0</MaxSendRate>',
    );
    expect(await service.getDailyQuotaQuick()).toEqual({max24HourSend: 50_000, sentLast24Hours: 120});

    respond = quota('<MaxSendRate>14.0</MaxSendRate>');
    expect(await service.getDailyQuotaQuick()).toBeNull();

    // The test setup's endpoint, where nothing listens
    expect(await (await sesServiceAt('http://127.0.0.1:1')).getDailyQuotaQuick()).toBeNull();
  });

  it('asks whether the account may send, and gives null without an answer', async () => {
    const enabled = (value: string) => (res: http.ServerResponse) => {
      res.writeHead(200, {'Content-Type': 'text/xml'});
      res.end(
        '<GetAccountSendingEnabledResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><GetAccountSendingEnabledResult>' +
          value +
          '</GetAccountSendingEnabledResult><ResponseMetadata><RequestId>r-e</RequestId></ResponseMetadata></GetAccountSendingEnabledResponse>',
      );
    };
    const service = await sesServiceAt(local());

    respond = enabled('<Enabled>false</Enabled>');
    expect(await service.getAccountSendingEnabledQuick()).toBe(false);
    respond = enabled('<Enabled>true</Enabled>');
    expect(await service.getAccountSendingEnabledQuick()).toBe(true);

    // The IAM policy without ses:GetAccountSendingEnabled
    respond = res => {
      res.writeHead(403, {'Content-Type': 'text/xml'});
      res.end(
        '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code>' +
          '<Message>not authorized to perform: ses:GetAccountSendingEnabled</Message></Error><RequestId>r-d</RequestId></ErrorResponse>',
      );
    };
    expect(await service.getAccountSendingEnabledQuick()).toBeNull();
  });
});

describe('safeToRetrySend', () => {
  it.each([
    ['SES refused it', Object.assign(new Error('MessageRejected'), {$metadata: {httpStatusCode: 400}}), true],
    ['SES failed', Object.assign(new Error('InternalFailure'), {$metadata: {httpStatusCode: 500}}), true],
    [
      'an accepted answer could not be read',
      Object.assign(new Error('parse'), {$metadata: {httpStatusCode: 200}}),
      false,
    ],
    [
      'the connection reset',
      Object.assign(new Error('socket hang up'), {name: 'TimeoutError', code: 'ECONNRESET', $metadata: {attempts: 1}}),
      false,
    ],
    [
      'the request timed out',
      Object.assign(new Error('exceeded the configured 15000 ms requestTimeout'), {
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
      }),
      false,
    ],
    ['the host was not found', Object.assign(new Error('getaddrinfo'), {code: 'ENOTFOUND'}), true],
    [
      'the network was unreachable',
      Object.assign(new Error('connect'), {code: 'ENETUNREACH', syscall: 'connect'}),
      true,
    ],
    [
      'the connection was reset after sending',
      Object.assign(new Error('read ECONNRESET'), {name: 'TimeoutError', code: 'ECONNRESET', syscall: 'read'}),
      false,
    ],
    [
      'the connection was never made',
      Object.assign(
        new Error('the request socket did not establish a connection with the server within the configured timeout'),
        {name: 'TimeoutError'},
      ),
      true,
    ],
    ['the error is unknown', new Error('Could not send email'), false],
  ])('when %s: %s', async (_case, error, expected) => {
    const {safeToRetrySend} = await import('../SESService');
    expect(safeToRetrySend(error)).toBe(expected);
  });
});
