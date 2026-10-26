import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {importedSubscription, importStatusSubscription, parseImportDate, splitImportRecord} from '../import-csv.js';

/**
 * Reading a CSV row's sign-up date and subscription status, for files from Plunk's export and from
 * other providers such as Flodesk.
 */
describe('splitImportRecord: createdAt and status', () => {
  it('reads status and createdAt apart, never as custom data', () => {
    const split = splitImportRecord({email: 'a@example.com', status: 'confirmed', createdat: '2023-04-05T08:09:10Z'});

    expect(split.data).toBeUndefined();
    expect(split).toMatchObject({
      statusSubscription: true,
      createdAt: new Date('2023-04-05T08:09:10Z'),
      invalidCreatedAt: false,
    });
  });

  it('lets a subscribed cell decide over status, as in Plunk export files', () => {
    const exported = splitImportRecord({email: 'a@example.com', subscribed: 'false', status: 'unsubscribed'});
    expect(exported.statusSubscription).toBeUndefined();
    expect(exported.unknownStatus).toBeUndefined();

    // A blank subscribed cell is no decision: status speaks
    expect(splitImportRecord({email: 'a@example.com', subscribed: '', status: 'Unsubscribed'})).toMatchObject({
      subscribed: undefined,
      statusSubscription: false,
    });
  });

  it('flags an unknown status and a filled but unusable createdAt', () => {
    expect(splitImportRecord({email: 'a@example.com', status: ' Weird ', createdat: '03/04/2024'})).toMatchObject({
      statusSubscription: undefined,
      unknownStatus: 'weird',
      createdAt: undefined,
      invalidCreatedAt: true,
    });
    expect(splitImportRecord({email: 'a@example.com', status: '', createdat: ''})).toMatchObject({
      statusSubscription: undefined,
      unknownStatus: undefined,
      createdAt: undefined,
      invalidCreatedAt: false,
    });
  });
});

describe('splitImportRecord: a file where only status speaks', () => {
  it('reads a blank or missing status as unknown, not as a reason to subscribe', () => {
    expect(splitImportRecord({email: 'a@example.com', status: ''}, {statusOnly: true})).toMatchObject({
      statusSubscription: undefined,
      unknownStatus: '',
    });
    // A short row has no key for the cells it lacks
    expect(splitImportRecord({email: 'a@example.com'}, {statusOnly: true}).unknownStatus).toBe('');
    expect(splitImportRecord({email: 'a@example.com', status: ''}).unknownStatus).toBeUndefined();
  });
});

describe('parseImportDate', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const parse = (value: string) => parseImportDate(value, now)?.toISOString() ?? null;

  // Dates must not depend on the server's zone
  beforeAll(() => {
    vi.stubEnv('TZ', 'Europe/Madrid');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('runs in a zone other than UTC', () => {
    expect(new Date('2024-01-15T00:00:00').getTimezoneOffset()).toBe(-60);
  });

  it('reads Flodesk and toISOString dates', () => {
    expect(parse('2024-01-15T10:30:00Z')).toBe('2024-01-15T10:30:00.000Z');
    expect(parse('2024-01-15T10:30:00.123Z')).toBe('2024-01-15T10:30:00.123Z');
    expect(parse('2024-01-15T10:30:00.5Z')).toBe('2024-01-15T10:30:00.500Z');
  });

  it('reads a date without a zone, with a space, or alone as UTC', () => {
    expect(parse('2024-01-15T10:30:00')).toBe('2024-01-15T10:30:00.000Z');
    expect(parse('2024-07-09 21:31:32')).toBe('2024-07-09T21:31:32.000Z');
    expect(parse('2024-07-09 21:31')).toBe('2024-07-09T21:31:00.000Z');
    expect(parse('2024-01-15')).toBe('2024-01-15T00:00:00.000Z');
  });

  it('cuts a longer fraction to milliseconds and takes lowercase t and z', () => {
    expect(parse('2024-01-15 10:30:00.123456+00:00')).toBe('2024-01-15T10:30:00.123Z');
    expect(parse('2024-01-15t10:30:00z')).toBe('2024-01-15T10:30:00.000Z');
  });

  it('applies a zone offset', () => {
    expect(parse('2024-01-15T10:30:00+02:00')).toBe('2024-01-15T08:30:00.000Z');
    expect(parse('2024-01-15T00:30-05:30')).toBe('2024-01-15T06:00:00.000Z');
  });

  it('rejects dates that do not exist', () => {
    expect(parse('2026-02-30')).toBeNull();
    expect(parse('2024-01-15T24:00')).toBeNull();
    expect(parse('2024-01-15T10:60')).toBeNull();
    expect(parse('2024-01-15T10:30:60Z')).toBeNull();
    expect(parse('2024-13-01')).toBeNull();
    expect(parse('2024-01-15T10:30+15:00')).toBeNull();
    expect(parse('2024-01-15T10:30+14:30')).toBeNull();
    expect(parse('2024-01-15T10:30+14:00')).toBe('2024-01-14T20:30:00.000Z');
  });

  it('rejects other formats and blanks', () => {
    expect(parse('03/04/2024')).toBeNull();
    expect(parse('2024-1-5')).toBeNull();
    expect(parse('1700000000')).toBeNull();
    expect(parse('')).toBeNull();
  });

  it('rejects dates before 1990 and more than a day ahead, and takes a smaller slip as now', () => {
    expect(parse('1989-12-31T23:59:59Z')).toBeNull();
    expect(parse('0099-01-01')).toBeNull();
    expect(parse('1990-01-01')).toBe('1990-01-01T00:00:00.000Z');
    expect(parse('2026-10-27T12:00:01Z')).toBeNull();
    expect(parse('2030-01-01')).toBeNull();
    expect(parse('2026-10-27T11:00:00Z')).toBe(now.toISOString());
  });
});

describe('importStatusSubscription', () => {
  it('maps statuses case-insensitively and fails closed on unknown ones', () => {
    for (const status of ['subscribed', 'Confirmed', 'ACTIVE']) {
      expect(importStatusSubscription(status)).toBe(true);
    }
    for (const status of [
      'unsubscribed',
      'bounced',
      'complained',
      'cleaned',
      'inactive',
      'unconfirmed',
      'pending',
      'cancelled',
    ]) {
      expect(importStatusSubscription(status)).toBe(false);
    }
    expect(importStatusSubscription(' Snoozed ')).toBe('snoozed');
    expect(importStatusSubscription('vip')).toBeUndefined();
  });
});

describe('importedSubscription', () => {
  const rowWith = (cells: Record<string, string>) => splitImportRecord({email: 'a@example.com', ...cells});

  it('subscribes new contacts only on a status that says so', () => {
    expect(importedSubscription(rowWith({status: 'confirmed'}), false)).toBe(true);
    expect(importedSubscription(rowWith({status: 'unsubscribed'}), false)).toBe(false);
    expect(importedSubscription(rowWith({status: 'snoozed'}), false)).toBe(false);
    expect(importedSubscription(rowWith({status: 'vip'}), false)).toBe(false);
    expect(importedSubscription(splitImportRecord({email: 'a@example.com'}, {statusOnly: true}), false)).toBe(false);
    // Neither column: upsert creates the contact subscribed
    expect(importedSubscription(rowWith({}), false)).toBeUndefined();
  });

  it('only ever unsubscribes an existing contact from status', () => {
    expect(importedSubscription(rowWith({status: 'confirmed'}), true)).toBeUndefined();
    expect(importedSubscription(rowWith({status: 'unsubscribed'}), true)).toBe(false);
    expect(importedSubscription(rowWith({status: 'snoozed'}), true)).toBeUndefined();
    expect(importedSubscription(rowWith({status: 'vip'}), true)).toBeUndefined();
  });

  it('lets the subscribed cell decide, keeping an exported snooze', () => {
    expect(importedSubscription(rowWith({subscribed: 'true', status: 'unsubscribed'}), true)).toBe(true);
    expect(importedSubscription(rowWith({subscribed: 'false', status: 'snoozed'}), true)).toBeUndefined();
    expect(importedSubscription(rowWith({subscribed: 'false', status: 'snoozed'}), false)).toBe(false);
  });
});
