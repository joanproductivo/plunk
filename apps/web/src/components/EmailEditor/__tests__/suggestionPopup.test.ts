// @vitest-environment happy-dom
import type {SuggestionProps} from '@tiptap/suggestion';
import {describe, expect, it, vi} from 'vitest';

import {SuggestionMenu, type SuggestionRow} from '../suggestionPopup';

function menu(items: SuggestionRow[], command = vi.fn()) {
  return {menu: new SuggestionMenu({items, command} as unknown as SuggestionProps, 'Nothing here'), command};
}

const key = (name: string) => new KeyboardEvent('keydown', {key: name});

describe('SuggestionMenu', () => {
  it('shows the syntax of a row that has one, and nothing for a row without', () => {
    const {menu: list} = menu([{label: 'Divider', syntax: '---'}, {label: 'Spacer'}]);
    const rows = list.element.querySelectorAll('.suggestion-row');

    expect(rows[0]!.querySelector('code')?.textContent).toBe('---');
    expect(rows[1]!.querySelector('code')).toBeNull();
  });

  it('chooses the selected row with Enter', () => {
    const {menu: list, command} = menu([{label: 'One'}, {label: 'Two'}]);

    expect(list.onKeyDown(key('ArrowDown'))).toBe(true);
    expect(list.onKeyDown(key('Enter'))).toBe(true);

    expect(command).toHaveBeenCalledWith({label: 'Two'});
  });

  it('leaves keys to the editor when nothing matches, so Enter still ends the line', () => {
    const {menu: list, command} = menu([]);

    for (const name of ['Enter', 'Tab', 'ArrowUp', 'ArrowDown']) {
      expect(list.onKeyDown(key(name))).toBe(false);
    }
    expect(command).not.toHaveBeenCalled();
    expect(list.element.textContent).toContain('Nothing here');
  });
});
