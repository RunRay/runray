import { PLAYBOOK_SOURCE_LABEL, PLAYBOOK_SOURCES } from '../insights/meta.js';
import {
  ERROR_CLASS_META,
  ERROR_OWNER_META,
  ERROR_OWNER_ORDER,
} from './meta.js';

/**
 * Markdown rendering of the error-class registry for docs/08-FINDINGS.md,
 * the same generated-block contract the rule playbooks use: the block
 * between the markers is written by `pnpm docs:playbooks` and a drift test
 * keeps the committed docs equal to the registry.
 */

export const ERROR_CLASSES_START = '<!-- error-classes:start -->';
export const ERROR_CLASSES_END = '<!-- error-classes:end -->';

export function renderErrorClassesMarkdown(): string {
  const out: string[] = [
    '<!-- Generated from ERROR_CLASS_META in packages/core/src/triage/meta.ts by `pnpm docs:playbooks`. Edit the registry, not this block. -->',
  ];
  for (const owner of ERROR_OWNER_ORDER) {
    const entries = Object.entries(ERROR_CLASS_META).filter(
      ([, meta]) => meta.owner === owner,
    );
    if (entries.length === 0) continue;
    const om = ERROR_OWNER_META[owner];
    out.push('', `### ${om.label}`, '', `*${om.meaning}.*`);
    for (const [id, meta] of entries) {
      const { causes, actions, limits } = meta.playbook;
      out.push('', `#### \`${id}\` · ${meta.label}`, '', meta.explain, '');
      out.push('**Why it happens**', '');
      for (const cause of causes) out.push(`- ${cause}`);
      out.push('', '**What you can do**');
      for (const source of PLAYBOOK_SOURCES) {
        out.push('', `*${PLAYBOOK_SOURCE_LABEL[source]}*`, '');
        for (const action of actions[source]) out.push(`- ${action}`);
      }
      out.push('', '**Out of your hands**', '');
      for (const limit of limits) out.push(`- ${limit}`);
    }
  }
  return `${out.join('\n')}\n`;
}
