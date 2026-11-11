import { describe, expect, it } from 'vitest';
import {
  ACTIVITIES,
  ACTIVITY_RANK,
  activityRank,
  HARNESS_TOOLS,
  harnessActivity,
  lookupTool,
  MODULE_ALIASES,
  PACKAGE_ALIASES,
  RUNNER_IDS,
  scriptActivity,
  TOOL_ALIASES,
  TOOL_DEFS,
  TOOL_IDS,
  toolById,
  toolLabel,
} from './registry.js';

/**
 * Registry invariants (tool-usage spec: "Closed tool registry", "Activity
 * taxonomy", "Harness tool classification"). The id list is snapshotted so
 * that removing or renaming a published id is a visible, deliberate diff.
 */

const ID_SHAPE = /^[a-z0-9_][a-z0-9_.+@-]*$/;

describe('registry invariants', () => {
  it('has unique ids', () => {
    const seen = new Map<string, number>();
    for (const def of TOOL_DEFS) seen.set(def.id, (seen.get(def.id) ?? 0) + 1);
    const duplicates = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    expect(duplicates).toEqual([]);
  });

  it('gives every entry a program-shaped id, a label and a known activity', () => {
    for (const def of TOOL_DEFS) {
      expect(def.id, def.id).toMatch(ID_SHAPE);
      expect(def.id).toBe(def.id.toLowerCase());
      expect(def.label.length, def.id).toBeGreaterThan(0);
      expect(ACTIVITIES, def.id).toContain(def.activity);
    }
  });

  it('keeps aliases apart from ids and pointed at existing entries', () => {
    for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
      expect(toolById(alias), `alias ${alias} is also an id`).toBeUndefined();
      expect(
        toolById(target.id),
        `alias ${alias} → ${target.id}`,
      ).toBeDefined();
    }
    for (const [name, id] of Object.entries(PACKAGE_ALIASES)) {
      expect(toolById(id), `package ${name} → ${id}`).toBeDefined();
    }
    for (const [name, id] of Object.entries(MODULE_ALIASES)) {
      expect(toolById(id), `module ${name} → ${id}`).toBeDefined();
    }
  });

  it('uses only known activities in subcommand tables', () => {
    for (const def of TOOL_DEFS) {
      for (const [sub, activity] of Object.entries(def.subs ?? {})) {
        expect(sub, def.id).toMatch(
          /^[a-z0-9][a-z0-9:._-]*( [a-z0-9][a-z0-9:._-]*)?$/,
        );
        if (activity !== null)
          expect(ACTIVITIES, `${def.id} ${sub}`).toContain(activity);
      }
    }
  });

  it('declares runner, script and skip subcommands inside the table', () => {
    for (const def of TOOL_DEFS) {
      const table = def.subs ?? {};
      for (const sub of [
        ...(def.runnerSubs ?? []),
        ...(def.scriptNext ?? []),
        ...Object.keys(def.runnerSkip ?? {}),
        ...Object.keys(def.skipAfter ?? {}),
      ]) {
        expect(Object.hasOwn(table, sub), `${def.id} ${sub}`).toBe(true);
      }
    }
  });

  it('ranks every activity exactly once', () => {
    expect([...ACTIVITY_RANK].sort()).toEqual([...ACTIVITIES].sort());
    expect(activityRank('build')).toBeLessThan(activityRank('vcs'));
    expect(activityRank('other')).toBeLessThan(activityRank('system'));
    expect(activityRank('system')).toBeLessThan(activityRank('explore'));
  });

  it('marks plumbing and utilities only on system and explore tools', () => {
    for (const def of TOOL_DEFS) {
      if (def.plumbing === true) expect(def.activity, def.id).toBe('system');
      if (def.utility === true) {
        expect(['system', 'explore'], def.id).toContain(def.activity);
      }
    }
  });

  it('keeps the published id list stable', () => {
    expect(TOOL_IDS).toMatchSnapshot();
  });

  it('keeps the runner vocabulary stable', () => {
    expect(RUNNER_IDS).toMatchSnapshot();
  });
});

describe('lookupTool', () => {
  it('resolves a known program (spec scenario)', () => {
    expect(lookupTool('docker')?.def.id).toBe('docker');
  });

  it('produces no id for an unknown program (spec scenario)', () => {
    expect(lookupTool('acme-deploy')).toBeUndefined();
  });

  it('resolves an alias with its implied words (spec scenario)', () => {
    const match = lookupTool('docker-compose');
    expect(match?.def.id).toBe('docker');
    expect(match?.prefix).toEqual(['compose']);
  });

  it('resolves versioned interpreters and launchers', () => {
    expect(lookupTool('python3.12')?.def.id).toBe('python');
    expect(lookupTool('pip3')?.def.id).toBe('pip');
    expect(lookupTool('py')?.def.id).toBe('python');
    expect(lookupTool('pwsh')?.def.id).toBe('powershell');
  });

  it('is not fooled by inherited object members', () => {
    for (const name of [
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ]) {
      expect(lookupTool(name)).toBeUndefined();
    }
  });

  it('labels cmdlets with their casing and unknown ids with themselves', () => {
    expect(toolLabel('get-childitem')).toBe('Get-ChildItem');
    expect(toolLabel('docker')).toBe('docker');
    expect(toolLabel('nope')).toBe('nope');
  });
});

describe('scriptActivity', () => {
  const cases: Array<[string, string]> = [
    ['test', 'test'],
    ['test:e2e', 'test'],
    ['e2e', 'test'],
    ['build', 'build'],
    ['app:build', 'build'],
    ['assembleDebug', 'build'],
    ['lint', 'check'],
    ['format:check', 'check'],
    ['typecheck', 'check'],
    ['type-check', 'check'],
    [':app:lintDebug', 'check'],
    ['db:reset', 'data'],
    ['migrate', 'data'],
    ['dev', 'run'],
    ['start', 'run'],
    ['deploy-preview', 'run'],
    ['clean', 'run'],
  ];
  for (const [name, activity] of cases) {
    it(`${name} → ${activity}`, () => {
      expect(scriptActivity(name)).toBe(activity);
    });
  }
});

describe('harness tools', () => {
  it('classifies the same work alike across harnesses (spec scenario)', () => {
    expect(harnessActivity('Read')).toBe('explore');
    expect(harnessActivity('read')).toBe('explore');
    expect(harnessActivity('Edit')).toBe('edit');
    expect(harnessActivity('apply_patch')).toBe('edit');
    expect(harnessActivity('WebFetch')).toBe('web');
  });

  it('classifies tools that block on the person as human (spec scenario)', () => {
    expect(harnessActivity('AskUserQuestion')).toBe('human');
    expect(harnessActivity('ExitPlanMode')).toBe('human');
    expect(harnessActivity('question')).toBe('human');
  });

  it('classifies an unknown tool as other (spec scenario)', () => {
    expect(harnessActivity('search_docs')).toBe('other');
    expect(harnessActivity('constructor')).toBe('other');
  });

  it('marks shell, skill and agent tools by role', () => {
    expect(HARNESS_TOOLS.get('Bash')?.role).toBe('shell');
    expect(HARNESS_TOOLS.get('PowerShell')?.role).toBe('shell');
    expect(HARNESS_TOOLS.get('bash')?.role).toBe('shell');
    expect(HARNESS_TOOLS.get('Skill')?.role).toBe('skill');
    expect(HARNESS_TOOLS.get('Agent')?.role).toBe('agent');
    expect(HARNESS_TOOLS.get('task')?.role).toBe('agent');
    expect(HARNESS_TOOLS.get('Read')?.role).toBeUndefined();
  });

  it('uses only known activities', () => {
    for (const [name, tool] of HARNESS_TOOLS) {
      expect(ACTIVITIES, name).toContain(tool.activity);
    }
  });
});
