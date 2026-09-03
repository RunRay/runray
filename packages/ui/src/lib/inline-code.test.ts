import { describe, expect, it } from 'vitest';
import { splitInlineCode } from './inline-code';

describe('splitInlineCode', () => {
  it('separates prose from backtick runs, in order', () => {
    expect(splitInlineCode('Run `/compact` at a checkpoint')).toEqual([
      { code: false, text: 'Run ' },
      { code: true, text: '/compact' },
      { code: false, text: ' at a checkpoint' },
    ]);
  });

  it('handles lines that start or end with code', () => {
    expect(splitInlineCode('`Read` with `limit`')).toEqual([
      { code: true, text: 'Read' },
      { code: false, text: ' with ' },
      { code: true, text: 'limit' },
    ]);
  });

  it('keeps a line without backticks as one prose run', () => {
    expect(splitInlineCode('Nothing to configure')).toEqual([
      { code: false, text: 'Nothing to configure' },
    ]);
  });

  it('renders an unbalanced backtick literally', () => {
    expect(splitInlineCode('a `b')).toEqual([{ code: false, text: 'a `b' }]);
  });
});
