import type { Run, Span } from '@runray/schema';

export interface IdentityTable {
  projects: Map<string, string>;
  transcripts: Map<string, string>;
  branches: Map<string, string>;
}

/**
 * Attribute allowlist (D2, trace-sanitization spec):
 * Retain reserved `runray.*` counters, `gen_ai.*`, and legacy `tracepulse.*`
 * internal metadata keys (excluding deleted display `tracepulse.target`).
 * Drop every other key without inspecting its value.
 */
export function isAttributeAllowed(key: string): boolean {
  if (key === 'runray.target' || key === 'tracepulse.target') {
    return false;
  }
  if (key.startsWith('gen_ai.')) {
    return true;
  }
  if (key.startsWith('runray.')) {
    return true;
  }
  if (key.startsWith('tracepulse.')) {
    return true;
  }
  return false;
}

export function scrubAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (attributes === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (isAttributeAllowed(k)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Collect distinct real values across all runs in the trace/build,
 * sort them lexicographically, and assign 1-indexed pseudonyms:
 * `project-N`, `transcript-N`, `branch-N`.
 */
export function createIdentityTable(runs: readonly Run[]): IdentityTable {
  const projectSet = new Set<string>();
  const transcriptSet = new Set<string>();
  const branchSet = new Set<string>();

  for (const run of runs) {
    if (run.project?.path) {
      projectSet.add(run.project.path);
    } else if (run.project?.name) {
      projectSet.add(run.project.name);
    }

    if (run.project?.gitBranch) {
      branchSet.add(run.project.gitBranch);
    }

    for (const f of run.source?.files ?? []) {
      transcriptSet.add(f);
    }

    for (const span of run.spans ?? []) {
      if (span.provenance?.file) {
        transcriptSet.add(span.provenance.file);
      }
    }

    for (const w of run.warnings ?? []) {
      if (w.file) {
        transcriptSet.add(w.file);
      }
    }
  }

  const sortedProjects = [...projectSet].sort();
  const sortedTranscripts = [...transcriptSet].sort();
  const sortedBranches = [...branchSet].sort();

  const projects = new Map<string, string>();
  sortedProjects.forEach((p, i) => {
    projects.set(p, `project-${i + 1}`);
  });

  const transcripts = new Map<string, string>();
  sortedTranscripts.forEach((t, i) => {
    transcripts.set(t, `transcript-${i + 1}`);
  });

  const branches = new Map<string, string>();
  sortedBranches.forEach((b, i) => {
    branches.set(b, `branch-${i + 1}`);
  });

  return { projects, transcripts, branches };
}

/**
 * Pure identity scrubber: replaces local paths and identifiers with deterministic
 * pseudonyms according to the shared mapping table. Input is observably unchanged.
 */
export function scrubIdentity(run: Run, table?: IdentityTable): Run {
  const t = table ?? createIdentityTable([run]);

  let project = run.project;
  if (project !== undefined) {
    let projId = 'project-1';
    if (project.path && t.projects.has(project.path)) {
      projId = t.projects.get(project.path) ?? 'project-1';
    } else if (project.name && t.projects.has(project.name)) {
      projId = t.projects.get(project.name) ?? 'project-1';
    }

    project = {
      ...project,
      ...(project.path !== undefined ? { path: projId } : {}),
      name: projId,
      ...(project.gitBranch !== undefined
        ? { gitBranch: t.branches.get(project.gitBranch) ?? 'branch-1' }
        : {}),
    };
  }

  const source = {
    ...run.source,
    files: run.source.files.map((f) => t.transcripts.get(f) ?? 'transcript-1'),
  };

  const warnings = run.warnings
    ? run.warnings.map((w) =>
        w.file
          ? { ...w, file: t.transcripts.get(w.file) ?? 'transcript-1' }
          : { ...w },
      )
    : undefined;

  const spans: Span[] = run.spans.map((span) => {
    const provenance = {
      ...span.provenance,
      file: t.transcripts.get(span.provenance.file) ?? 'transcript-1',
    };
    const attributes = scrubAttributes(span.attributes);
    return {
      ...span,
      provenance,
      ...(attributes !== undefined ? { attributes } : {}),
    };
  });

  const { title: _droppedTitle, ...rest } = run;

  return {
    ...rest,
    ...(project !== undefined ? { project } : {}),
    source,
    warnings,
    spans,
  };
}

export function scrubIdentityRuns(
  runs: readonly Run[],
  table?: IdentityTable,
): Run[] {
  const t = table ?? createIdentityTable(runs);
  return runs.map((r) => scrubIdentity(r, t));
}
