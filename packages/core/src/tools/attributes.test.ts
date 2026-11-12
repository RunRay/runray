import { describe, expect, it } from 'vitest';
import { isReservedMetadataKey } from '../attribute-keys.js';
import { isAttributeAllowed, scrubAttributes } from '../sanitize/identity.js';
import {
  CLOSED_TOOL_ATTRS,
  FREE_TOOL_ATTRS,
  isValidToolAttribute,
  TOOL_ATTR,
  TOOL_FLAGS,
} from './attributes.js';
import { toolUsageAttributes } from './classify.js';

/**
 * Attribute vocabulary and allowlist (trace-sanitization delta "Attribute
 * allowlist"; trace-ingestion delta "Reserved tool-usage keys from OTLP are
 * validated"). A closed key is kept by name by the sanitizer, so its value
 * must be provably inside the vocabulary.
 */

describe('isValidToolAttribute', () => {
  const valid: Array<[string, unknown, unknown?]> = [
    [TOOL_ATTR.activity, 'infra'],
    [TOOL_ATTR.activity, 'other'],
    [TOOL_ATTR.tool, 'docker'],
    [TOOL_ATTR.tool, 'get-childitem'],
    [TOOL_ATTR.via, 'pnpm exec'],
    [TOOL_ATTR.via, 'bash -c'],
    [TOOL_ATTR.sub, 'compose up', 'docker'],
    [TOOL_ATTR.sub, 'run'],
    [TOOL_ATTR.sub, 'script'],
    [TOOL_ATTR.sub, 'inline', 'node'],
    [TOOL_ATTR.also, ['git', 'docker']],
    [TOOL_ATTR.flags, ['background']],
    [TOOL_ATTR.flags, [...TOOL_FLAGS]],
    [TOOL_ATTR.hookCount, 0],
    [TOOL_ATTR.hookCount, 3],
  ];
  for (const [key, value, tool] of valid) {
    it(`accepts ${key} = ${JSON.stringify(value)}`, () => {
      expect(isValidToolAttribute(key, value, tool)).toBe(true);
    });
  }

  const invalid: Array<[string, unknown, unknown?]> = [
    [TOOL_ATTR.activity, 'deploying'],
    [TOOL_ATTR.activity, 3],
    [TOOL_ATTR.tool, '/Users/alex/bin/deploy'],
    [TOOL_ATTR.tool, 'acme-deploy'],
    [TOOL_ATTR.tool, ['docker']],
    [TOOL_ATTR.tool, 'constructor'],
    [TOOL_ATTR.via, 'my-wrapper'],
    [TOOL_ATTR.sub, 'compose up'], // no tool to check the table of
    [TOOL_ATTR.sub, 'compose up', 'git'],
    [TOOL_ATTR.sub, 'frobnicate', 'git'],
    [TOOL_ATTR.sub, 'toString', 'git'],
    [TOOL_ATTR.also, []],
    [TOOL_ATTR.also, ['git', 'git']],
    [TOOL_ATTR.also, ['git', 'acme-tool']],
    [TOOL_ATTR.also, 'git'],
    [
      TOOL_ATTR.also,
      ['git', 'gh', 'docker', 'kubectl', 'helm', 'aws', 'az', 'psql', 'curl'],
    ],
    [TOOL_ATTR.flags, []],
    [TOOL_ATTR.flags, ['background', 'exploded']],
    [TOOL_ATTR.flags, 'background'],
    [TOOL_ATTR.hookCount, -1],
    [TOOL_ATTR.hookCount, 1.5],
    [TOOL_ATTR.hookCount, '3'],
    [TOOL_ATTR.name, 'anything'], // free-form keys have no vocabulary
    ['runray.notes', 'x'],
  ];
  for (const [key, value, tool] of invalid) {
    it(`rejects ${key} = ${JSON.stringify(value)}${tool === undefined ? '' : ` (tool ${String(tool)})`}`, () => {
      expect(isValidToolAttribute(key, value, tool)).toBe(false);
    });
  }

  it('accepts everything the classifier itself emits', () => {
    const commands = [
      'cd apps/web && pnpm exec vitest run 2>&1 | tail -20',
      'git add -A && pnpm build',
      'docker compose -f dev.yml up -d',
      'bash -c "cd api && cargo test"',
      'python -m pytest -q',
      'acme-deploy --prod',
      './scripts/deploy.sh',
      '',
    ];
    for (const command of commands) {
      const attrs = toolUsageAttributes(command, 'posix', true);
      for (const [key, value] of Object.entries(attrs)) {
        expect(
          isValidToolAttribute(key, value, attrs[TOOL_ATTR.tool]),
          `${command} → ${key}`,
        ).toBe(true);
      }
    }
  });
});

describe('attribute allowlist', () => {
  it('keeps the closed keys and never the free-form ones', () => {
    for (const key of CLOSED_TOOL_ATTRS) {
      expect(isReservedMetadataKey(key), key).toBe(true);
      expect(isAttributeAllowed(key), key).toBe(true);
    }
    for (const key of FREE_TOOL_ATTRS) {
      expect(isReservedMetadataKey(key), key).toBe(false);
      expect(isAttributeAllowed(key), key).toBe(false);
    }
  });

  it('lets tool identity survive sanitizing while free-form names do not (spec scenario)', () => {
    const attributes = {
      [TOOL_ATTR.tool]: 'pnpm',
      [TOOL_ATTR.sub]: 'run',
      [TOOL_ATTR.activity]: 'build',
      [TOOL_ATTR.via]: 'bash -c',
      [TOOL_ATTR.also]: ['git'],
      [TOOL_ATTR.flags]: ['background'],
      [TOOL_ATTR.name]: 'acme-deploy',
      [TOOL_ATTR.script]: 'build:acme',
      [TOOL_ATTR.skill]: 'acme-runbook',
    };
    expect(scrubAttributes(attributes)).toEqual({
      [TOOL_ATTR.tool]: 'pnpm',
      [TOOL_ATTR.sub]: 'run',
      [TOOL_ATTR.activity]: 'build',
      [TOOL_ATTR.via]: 'bash -c',
      [TOOL_ATTR.also]: ['git'],
      [TOOL_ATTR.flags]: ['background'],
    });
  });

  it('sanitizes a redacted and an unredacted classification to the same attributes (spec scenario)', () => {
    for (const command of [
      'git add -A && pnpm build',
      'npm run db:reset',
      'acme-deploy --prod',
      'node scripts/seed.mjs',
      './scripts/deploy.sh --prod',
    ]) {
      expect(
        scrubAttributes(toolUsageAttributes(command, 'posix', false)),
      ).toEqual(scrubAttributes(toolUsageAttributes(command, 'posix', true)));
    }
  });
});
