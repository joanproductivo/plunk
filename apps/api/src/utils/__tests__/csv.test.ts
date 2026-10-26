import {describe, expect, it} from 'vitest';
import {csvCell, csvRow, neutraliseFormula, unescapeCsvFormula} from '../csv.js';

describe('csv', () => {
  describe('csvCell', () => {
    it('leaves plain values bare', () => {
      expect(csvCell('Ana')).toBe('Ana');
      expect(csvCell(42)).toBe('42');
      expect(csvCell(true)).toBe('true');
      expect(csvCell('Café ñandú')).toBe('Café ñandú');
    });

    it('writes nothing for missing values', () => {
      expect(csvCell(null)).toBe('');
      expect(csvCell(undefined)).toBe('');
    });

    it('quotes cells with separators, quotes, line breaks or edge spaces', () => {
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
      expect(csvCell(' padded ')).toBe('" padded "');
    });

    it('writes dates as ISO and objects as JSON', () => {
      expect(csvCell(new Date('2026-10-25T10:00:00.000Z'))).toBe('2026-10-25T10:00:00.000Z');
      expect(csvCell({plan: 'pro', seats: 2})).toBe('"{""plan"":""pro"",""seats"":2}"');
      expect(csvCell(['a', 'b'])).toBe('"[""a"",""b""]"');
    });
  });

  describe('formula neutralisation', () => {
    it('neutralises text a spreadsheet would run', () => {
      expect(csvCell('=1+1')).toBe("'=1+1");
      expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
      expect(csvCell('+HYPERLINK("x")')).toBe('"\'+HYPERLINK(""x"")"');
      expect(csvCell('-2+3+cmd|x')).toBe("'-2+3+cmd|x");
      expect(csvCell('\tcmd')).toBe("'\tcmd");
      expect(csvCell(' =1+1')).toBe("' =1+1");
    });

    it('leaves numbers and phone numbers alone', () => {
      expect(csvCell('+34 600 00 00 00')).toBe('+34 600 00 00 00');
      expect(csvCell('+1 (555) 010-0000')).toBe('+1 (555) 010-0000');
      expect(csvCell('-5')).toBe('-5');
      expect(csvCell(-5)).toBe('-5');
    });

    it('round-trips through the import', () => {
      const values = [
        '=1+1',
        '@user',
        '+HYPERLINK(x)',
        "'=already",
        "''=twice",
        "'-5",
        "''-5",
        '-5',
        '+34 600',
        ' =1+1',
        "'",
        'plain',
        "it's",
      ];
      for (const value of values) {
        expect(unescapeCsvFormula(neutraliseFormula(value))).toBe(value);
      }
    });

    it('does not strip an apostrophe the import did not add', () => {
      expect(unescapeCsvFormula("'-5")).toBe("'-5");
      expect(unescapeCsvFormula("it's")).toBe("it's");
    });
  });

  it('builds CRLF-terminated rows', () => {
    expect(csvRow(['a@example.com', true, null, 'x,y'])).toBe('a@example.com,true,,"x,y"\r\n');
  });
});
