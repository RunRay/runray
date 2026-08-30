import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';

const dir = mkdtempSync(join(tmpdir(), 'runray-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function withConfig(name: string, body: unknown) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe('limitWindow config (E1)', () => {
  it('accepts a valid block', () => {
    const config = loadConfig(
      withConfig('valid.json', {
        limitWindow: {
          days: 7,
          resetDay: 'thu',
          resetHour: 14,
          budgetUSD: 250,
        },
      }),
    );
    expect(config.limitWindow).toEqual({
      days: 7,
      resetDay: 'thu',
      resetHour: 14,
      budgetUSD: 250,
    });
  });

  it('drops invalid fields with a warning, keeps the valid ones', () => {
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const config = loadConfig(
        withConfig('partial.json', {
          limitWindow: {
            days: 7,
            resetDay: 'someday',
            resetHour: 99,
            budgetTokens: -5,
          },
        }),
      );
      expect(config.limitWindow).toEqual({ days: 7 });
      const msg = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(msg).toContain('limitWindow');
      expect(msg).toContain('resetDay');
    } finally {
      spy.mockRestore();
    }
  });

  it('an entirely invalid block disappears (absent-block no-op)', () => {
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const config = loadConfig(
        withConfig('broken.json', { limitWindow: 'thursday' }),
      );
      expect(config.limitWindow).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('no block → no key, nothing changes', () => {
    const config = loadConfig(withConfig('none.json', { port: 4200 }));
    expect(config.limitWindow).toBeUndefined();
    expect(config.port).toBe(4200);
  });
});
