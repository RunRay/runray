/**
 * Closed tool registry (tool-usage capability, design T5).
 *
 * A program name becomes a tool id only when it is an entry here; nothing a
 * session typed can add one. That is what lets a tool id survive redaction:
 * the vocabulary ships with core. Published ids are stable (a snapshot test
 * makes a removal or rename a deliberate diff); adding entries is routine.
 *
 * The file is data plus lookups. It imports nothing at runtime, so it is
 * safe in the browser-safe subpath `@runray/core/tools`.
 */
import type { ShellDialect } from './shell.js';

/** What kind of work a tool call was. Closed set. */
export const ACTIVITIES = [
  'explore',
  'edit',
  'run',
  'check',
  'build',
  'test',
  'vcs',
  'deps',
  'infra',
  'cloud',
  'data',
  'web',
  'system',
  'devices',
  'agent',
  'human',
  'integration',
  'other',
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/**
 * Expected-duration order used to pick the primary tool of a command that
 * runs several (design T6): the activity that usually takes longest names
 * the call. Derived from mean call durations in the measured sample; a fixed
 * array, so the choice stays a pure function of the command text.
 */
export const ACTIVITY_RANK: readonly Activity[] = [
  'build',
  'check',
  'test',
  'data',
  'cloud',
  'deps',
  'devices',
  'web',
  'run',
  'infra',
  'vcs',
  'edit',
  'integration',
  'agent',
  'human',
  'other',
  'system',
  'explore',
];

/** Lower is "more likely the work the call was for". */
export function activityRank(activity: Activity): number {
  const index = ACTIVITY_RANK.indexOf(activity);
  return index === -1 ? ACTIVITY_RANK.length : index;
}

/** Subcommand → activity override; `null` keeps the tool's default. */
export type SubTable = Readonly<Record<string, Activity | null>>;

export interface ShellSpec {
  dialect: ShellDialect;
  /** Lowercase flags after which the next word is a command string. */
  flags: readonly string[];
  /** `-lc`, `-ic`: any short flag cluster ending in `c` also qualifies. */
  clustered?: true;
  /** The command is the rest of the words joined, not one word (`cmd /c`). */
  rest?: true;
}

export interface ToolDef {
  id: string;
  label: string;
  activity: Activity;
  /** One of the short-lived shell tools the Time view folds into one group. */
  utility?: true;
  /** Navigation, environment and flow builtins: never the work itself. */
  plumbing?: true;
  /** Closed subcommand table; keys are one or two words. */
  subs?: SubTable;
  /** Options that take a separate value, skipped before the subcommand. */
  valueOptions?: readonly string[];
  /** A first word outside `subs` is a user-defined script or task name. */
  scripts?: true;
  /** Subcommands followed by a script or task name (`run`, `task`). */
  scriptNext?: readonly string[];
  /** Subcommands that hand off to another program (`exec`, `dlx`). */
  runnerSubs?: readonly string[];
  /** Positional words a runner subcommand consumes first (`rustup run <toolchain>`). */
  runnerSkip?: Readonly<Record<string, number>>;
  /** Positional words to step over before reading on (`yarn workspace <name>`). */
  skipAfter?: Readonly<Record<string, number>>;
  /** The program itself hands off to another program (`npx`). */
  runner?: true;
  /** Flag after which the next word is a module to run (`python -m`). */
  moduleFlag?: string;
  /** A shell that can be handed a command string. */
  shell?: ShellSpec;
  /** Runs a file or inline code; `inline` lists the flags for inline code. */
  interpreter?: { inline: readonly string[] };
  /** Several targets per call: the best-ranked one names the call. */
  multi?: true;
  /** `+nightly`-style words are options, not subcommands. */
  toolchainPrefix?: true;
  /** Flags that change the activity (`node --test`). */
  activityFlags?: Readonly<Record<string, Activity>>;
}

function list(spec: string): string[] {
  const parts = spec.includes('|') ? spec.split('|') : spec.split(/\s+/);
  return parts
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter((p) => p !== '');
}

/** `{ same: 'a b', build: 'c' }` → `{ a: null, b: null, c: 'build' }`. */
function subs(spec: Partial<Record<Activity | 'same', string>>): SubTable {
  const out: Record<string, Activity | null> = {};
  for (const [activity, words] of Object.entries(spec)) {
    for (const key of list(words)) {
      out[key] = activity === 'same' ? null : (activity as Activity);
    }
  }
  return out;
}

/** Entries that need nothing but a name; the label keeps the given casing. */
function simple(
  activity: Activity,
  names: string,
  flags: { utility?: true; plumbing?: true } = {},
): ToolDef[] {
  return list(names).map((label) => ({
    id: label.toLowerCase(),
    label,
    activity,
    ...flags,
  }));
}

const POSIX_SHELL: ShellSpec = {
  dialect: 'posix',
  flags: ['-c'],
  clustered: true,
};

const DOCKER_SUBS = subs({
  same: `ps|exec|run|logs|images|pull|push|stop|start|restart|rm|rmi|inspect|info
    |version|login|logout|tag|cp|kill|stats|top|port|diff|commit|save|load|export
    |import|events|history|search|wait|attach|rename|update|pause|unpause|create
    |compose|compose up|compose down|compose ps|compose logs|compose exec
    |compose run|compose pull|compose push|compose restart|compose stop
    |compose start|compose rm|compose config|compose kill|compose top
    |compose images|compose create|compose watch|compose cp|compose ls
    |compose version|buildx|buildx ls|buildx create|buildx use|buildx inspect
    |buildx prune|system|system prune|system df|system info|volume|volume ls
    |volume rm|volume create|volume inspect|volume prune|network|network ls
    |network create|network rm|network inspect|network connect|network prune
    |image|image ls|image rm|image prune|image inspect|image pull|image push
    |image tag|container|container ls|container rm|container prune
    |container inspect|container logs|container exec|context|context ls
    |context use|manifest|scout|builder|builder prune|swarm|service|stack|node
    |plugin|secret|config`,
  build: 'build|compose build|buildx build|buildx bake|image build',
});
const DOCKER_OPTIONS = [
  '--context',
  '-H',
  '--host',
  '--config',
  '-l',
  '--log-level',
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--profile',
  '--env-file',
  '--project-directory',
  '--ansi',
  '--progress',
];

const TERRAFORM_SUBS = subs({
  same: `init|plan|apply|destroy|output|state|state list|state show|state mv
    |state rm|state pull|state push|import|workspace|workspace select
    |workspace list|workspace new|workspace show|show|providers|graph|refresh
    |taint|untaint|console|login|logout|version|get|force-unlock`,
  check: 'validate|fmt',
  test: 'test',
});

const PM_VALUE_OPTIONS = [
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '-w',
  '--workspace',
  '--cwd',
  '--workspace-concurrency',
  '--reporter',
  '--loglevel',
  '--registry',
  '--userconfig',
  '--cache',
];

/** Tools whose behaviour needs more than a name. */
const RICH: ToolDef[] = [
  // ---- version control -------------------------------------------------
  {
    id: 'git',
    label: 'git',
    activity: 'vcs',
    valueOptions: ['-C', '-c', '--git-dir', '--work-tree', '--namespace'],
    subs: subs({
      same: `status diff add commit push pull fetch log show checkout switch
        branch merge rebase stash worktree clone reset restore tag grep
        ls-files ls-tree ls-remote rev-parse rev-list cherry-pick remote config
        init rm mv blame describe apply am bisect clean reflog revert submodule
        cat-file check-ignore diff-tree merge-base for-each-ref symbolic-ref
        shortlog format-patch gc fsck archive notes sparse-checkout lfs
        name-rev show-ref update-index update-ref hash-object count-objects
        var version help range-diff whatchanged diff-index diff-files
        interpret-trailers verify-commit verify-tag maintenance bundle
        credential annotate difftool mergetool prune repack pack-refs
        read-tree write-tree commit-tree check-attr check-ref-format`,
    }),
  },
  {
    id: 'gh',
    label: 'gh',
    activity: 'vcs',
    valueOptions: ['-R', '--repo', '--hostname'],
    subs: subs({
      same: `pr|pr view|pr create|pr checks|pr list|pr merge|pr diff|pr status
        |pr checkout|pr comment|pr review|pr edit|pr close|pr ready|pr reopen
        |issue|issue view|issue create|issue list|issue comment|issue edit
        |issue close|issue status|issue reopen|run|run watch|run view|run list
        |run rerun|run cancel|run download|repo|repo view|repo clone
        |repo create|repo list|repo edit|repo fork|release|release view
        |release create|release list|release upload|release download
        |release edit|release delete|workflow|workflow run|workflow view
        |workflow list|workflow enable|workflow disable|auth|auth status
        |auth login|auth token|secret|secret set|secret list|variable
        |variable set|variable list|label|label list|label create|project
        |project view|project list|project item-add|project item-list
        |project item-edit|project field-list|cache|cache list|cache delete
        |ruleset|ruleset list|ruleset view|search|search prs|search issues
        |search code|search repos|gist|gist create|gist view|gist list
        |codespace|api|browse|status|extension`,
    }),
  },

  // ---- JS package managers and task runners ----------------------------
  {
    id: 'pnpm',
    label: 'pnpm',
    activity: 'deps',
    scripts: true,
    valueOptions: PM_VALUE_OPTIONS,
    scriptNext: ['run', 'run-script'],
    runnerSubs: ['exec', 'dlx'],
    subs: subs({
      same: `install i add remove rm uninstall un update up upgrade audit
        outdated list ls ll why licenses link ln unlink rebuild rb prune store
        config import fetch dedupe patch patch-commit patch-remove
        approve-builds ignored-builds setup env self-update cache root bin
        server run run-script exec dlx`,
      cloud: 'publish login logout whoami',
      build: 'pack deploy',
      run: 'init create',
      check: 'doctor',
    }),
  },
  {
    id: 'npm',
    label: 'npm',
    activity: 'deps',
    scripts: true,
    valueOptions: PM_VALUE_OPTIONS,
    scriptNext: ['run', 'run-script', 'rum', 'urn'],
    runnerSubs: ['exec', 'x'],
    subs: subs({
      same: `install i ci add uninstall remove rm un update up upgrade audit
        outdated ls list ll la view info show v search link ln unlink rebuild
        prune dedupe ddp config c get set cache pkg fund explain why bin root
        prefix help token owner access dist-tag star ping repo docs bugs edit
        explore shrinkwrap sbom query diff completion install-test it
        install-ci-test cit run run-script rum urn exec x`,
      cloud: 'publish unpublish deprecate login logout adduser whoami',
      build: 'pack',
      run: 'init create',
      check: 'doctor',
      vcs: 'version',
    }),
  },
  {
    id: 'yarn',
    label: 'yarn',
    activity: 'deps',
    scripts: true,
    valueOptions: PM_VALUE_OPTIONS,
    scriptNext: ['run'],
    runnerSubs: ['exec', 'dlx', 'node'],
    skipAfter: { workspace: 1 },
    subs: subs({
      same: `install add remove up upgrade upgrade-interactive audit outdated
        list info why link unlink rebuild dedupe config cache versions set
        plugin policies bin import licenses global workspace workspaces npm
        constraints patch patch-commit explain stage run exec dlx node`,
      cloud: 'publish login logout',
      build: 'pack',
      run: 'init create',
      check: 'check',
      vcs: 'version',
    }),
  },
  {
    id: 'bun',
    label: 'bun',
    activity: 'run',
    scripts: true,
    valueOptions: PM_VALUE_OPTIONS,
    scriptNext: ['run'],
    runnerSubs: ['x'],
    interpreter: { inline: ['-e', '--eval', '-p', '--print'] },
    subs: subs({
      deps: 'install i add remove rm update upgrade outdated link unlink pm patch audit why',
      cloud: 'publish',
      build: 'build',
      test: 'test',
      same: 'run x repl exec init create',
    }),
  },
  {
    id: 'npx',
    label: 'npx',
    activity: 'run',
    runner: true,
    valueOptions: ['-p', '--package', '-c', '--call'],
  },
  { id: 'pnpx', label: 'pnpx', activity: 'run', runner: true },
  { id: 'bunx', label: 'bunx', activity: 'run', runner: true },
  {
    id: 'turbo',
    label: 'turbo',
    activity: 'build',
    scripts: true,
    multi: true,
    valueOptions: ['--filter', '-F', '--cwd', '--concurrency', '--cache-dir'],
    scriptNext: ['run', 'watch'],
    subs: subs({
      same: 'run watch prune daemon gen generate telemetry scan ls query',
      cloud: 'login logout link unlink',
      check: 'boundaries',
    }),
  },
  {
    id: 'nx',
    label: 'nx',
    activity: 'build',
    scripts: true,
    scriptNext: ['run'],
    runnerSubs: ['exec'],
    subs: subs({
      same: 'run run-many affected graph show list report daemon watch repair sync exec',
      run: 'init generate g',
      deps: 'migrate add',
      system: 'reset',
      cloud: 'release login connect',
    }),
  },
  {
    id: 'make',
    label: 'make',
    activity: 'build',
    scripts: true,
    multi: true,
    valueOptions: ['-C', '-f', '--file', '--directory'],
  },
  {
    id: 'just',
    label: 'just',
    activity: 'run',
    scripts: true,
    valueOptions: ['-f', '--justfile', '-d', '--working-directory'],
  },
  {
    id: 'task',
    label: 'task',
    activity: 'run',
    scripts: true,
    valueOptions: ['-t', '--taskfile', '-d', '--dir'],
  },
  {
    id: 'rake',
    label: 'rake',
    activity: 'run',
    scripts: true,
    valueOptions: ['-f', '--rakefile'],
  },
  {
    id: 'gradle',
    label: 'gradle',
    activity: 'build',
    scripts: true,
    multi: true,
    valueOptions: [
      '-p',
      '--project-dir',
      '-b',
      '-c',
      '-I',
      '-g',
      '-x',
      '--exclude-task',
    ],
  },
  {
    id: 'mvn',
    label: 'mvn',
    activity: 'build',
    multi: true,
    valueOptions: [
      '-f',
      '--file',
      '-pl',
      '--projects',
      '-P',
      '-s',
      '--settings',
    ],
    subs: subs({
      build: 'compile package install site',
      test: 'test verify integration-test',
      system: 'clean',
      cloud: 'deploy',
      check: 'validate',
    }),
  },

  // ---- language toolchains ---------------------------------------------
  {
    id: 'cargo',
    label: 'cargo',
    activity: 'build',
    toolchainPrefix: true,
    valueOptions: ['--manifest-path', '--color', '-Z', '--config', '-C'],
    subs: subs({
      build:
        'build doc ndk tauri zigbuild package rustc rustdoc dist component leptos chef',
      check:
        'check clippy fmt deny audit fix machete udeps hack semver-checks msrv',
      test: 'test bench nextest llvm-cov tarpaulin miri criterion insta',
      run: 'run watch new init xtask flamegraph make',
      deps: 'add remove rm update install uninstall fetch vendor tree search outdated generate-lockfile binstall',
      cloud: 'publish login logout release lambda',
      system: 'clean version locate-project pkgid',
      explore: 'metadata expand bloat',
      data: 'sqlx',
    }),
  },
  {
    id: 'go',
    label: 'go',
    activity: 'build',
    valueOptions: ['-C'],
    subs: subs({
      build: 'build generate',
      test: 'test',
      check: 'vet fmt fix',
      run: 'run tool',
      deps: `mod|mod tidy|mod download|mod init|mod vendor|mod verify|mod why
        |mod graph|mod edit|get|install|work`,
      system: 'env version clean',
      explore: 'list doc',
    }),
  },
  {
    id: 'dotnet',
    label: 'dotnet',
    activity: 'build',
    runnerSubs: ['tool run'],
    subs: subs({
      build: 'build publish pack msbuild',
      test: 'test',
      run: 'run watch new sln',
      deps: `restore|add|remove|list|nuget|workload|tool|tool install
        |tool restore|tool update|tool list|tool run`,
      check: 'format',
      data: 'ef|ef migrations|ef database|ef dbcontext',
      system: 'clean dev-certs user-secrets',
    }),
  },
  {
    id: 'flutter',
    label: 'flutter',
    activity: 'build',
    valueOptions: ['-d', '--device-id'],
    subs: subs({
      build: 'build gen-l10n assemble',
      test: 'test drive',
      check: 'analyze format',
      deps: `pub|pub get|pub add|pub upgrade|pub outdated|pub run|pub deps
        |pub remove|pub global|upgrade|downgrade|channel|precache`,
      run: 'run create attach daemon',
      system: 'clean config',
      devices:
        'doctor devices emulators install logs screenshot custom-devices',
      explore: 'symbolize',
    }),
  },
  {
    id: 'dart',
    label: 'dart',
    activity: 'run',
    subs: subs({
      check: 'analyze format fix',
      test: 'test',
      run: 'run create devtools',
      deps: `pub|pub get|pub add|pub upgrade|pub outdated|pub run|pub global
        |pub deps|pub publish`,
      build: 'compile doc',
      system: 'info',
    }),
  },
  {
    id: 'swift',
    label: 'swift',
    activity: 'build',
    subs: subs({
      build: 'build',
      test: 'test',
      run: 'run',
      deps: `package|package resolve|package update|package init|package clean
        |package describe|package show-dependencies|package dump-package`,
      check: 'format',
    }),
  },
  {
    id: 'xcodebuild',
    label: 'xcodebuild',
    activity: 'build',
    multi: true,
    valueOptions: [
      '-scheme',
      '-workspace',
      '-project',
      '-configuration',
      '-destination',
      '-sdk',
      '-derivedDataPath',
      '-archivePath',
      '-exportPath',
      '-exportOptionsPlist',
      '-target',
      '-arch',
      '-xcconfig',
      '-resultBundlePath',
      '-testPlan',
    ],
    subs: subs({
      build: 'build archive install build-for-testing',
      test: 'test test-without-building',
      system: 'clean',
      check: 'analyze',
    }),
  },
  {
    id: 'mix',
    label: 'mix',
    activity: 'build',
    subs: subs({
      test: 'test',
      build: 'compile release',
      check: 'format credo dialyzer',
      deps: 'deps.get deps.compile deps.update',
      run: 'run phx.server phx.new',
      data: 'ecto.migrate ecto.create ecto.reset ecto.rollback',
      system: 'clean help',
    }),
  },
  {
    id: 'deno',
    label: 'deno',
    activity: 'run',
    scriptNext: ['run', 'task'],
    subs: subs({
      run: 'run task eval serve repl jupyter init',
      test: 'test bench coverage',
      check: 'lint fmt check',
      build: 'compile doc',
      deps: 'install add remove cache upgrade outdated uninstall',
      cloud: 'publish',
      explore: 'info',
      system: 'clean',
    }),
  },

  // ---- Python ------------------------------------------------------------
  {
    id: 'python',
    label: 'python',
    activity: 'run',
    moduleFlag: '-m',
    valueOptions: ['-W', '-X'],
    interpreter: { inline: ['-c'] },
  },
  {
    id: 'pip',
    label: 'pip',
    activity: 'deps',
    valueOptions: ['--python', '--proxy', '--cache-dir'],
    subs: subs({
      same: 'install uninstall download freeze list show config search cache index hash debug inspect',
      check: 'check',
      build: 'wheel',
    }),
  },
  {
    id: 'uv',
    label: 'uv',
    activity: 'deps',
    valueOptions: [
      '--project',
      '--directory',
      '--python',
      '-p',
      '--config-file',
      '--color',
      '--with',
      '--extra',
      '--group',
      '--env-file',
      '--package',
    ],
    runnerSubs: ['run', 'tool run'],
    subs: subs({
      same: `pip|pip install|pip uninstall|pip list|pip freeze|pip compile
        |pip sync|pip show|pip check|pip tree|sync|lock|add|remove|venv|python
        |python install|python list|python pin|python find|tool|tool install
        |tool list|tool uninstall|tool upgrade|tool run|tree|export|cache
        |self|version|run`,
      run: 'init',
      build: 'build',
      cloud: 'publish',
    }),
  },
  {
    id: 'uvx',
    label: 'uvx',
    activity: 'run',
    runner: true,
    valueOptions: ['--from', '--with', '--python', '-p'],
  },
  {
    id: 'pipx',
    label: 'pipx',
    activity: 'deps',
    runnerSubs: ['run'],
    subs: subs({
      same: 'run install uninstall list upgrade inject ensurepath reinstall',
    }),
  },
  {
    id: 'poetry',
    label: 'poetry',
    activity: 'deps',
    runnerSubs: ['run'],
    subs: subs({
      same: `install|add|remove|update|lock|show|run|env|env use|env info
        |env list|env remove|config|export|self|cache|search|sync`,
      build: 'build',
      cloud: 'publish',
      run: 'shell init new',
      check: 'check',
      vcs: 'version',
    }),
  },
  {
    id: 'pdm',
    label: 'pdm',
    activity: 'deps',
    runnerSubs: ['run'],
    subs: subs({
      same: 'run install add remove update lock sync list',
      build: 'build',
      cloud: 'publish',
    }),
  },
  {
    id: 'hatch',
    label: 'hatch',
    activity: 'deps',
    runnerSubs: ['run'],
    subs: subs({
      same: 'run env dep',
      build: 'build',
      cloud: 'publish',
      test: 'test',
      check: 'fmt',
      vcs: 'version',
    }),
  },
  {
    id: 'pipenv',
    label: 'pipenv',
    activity: 'deps',
    runnerSubs: ['run'],
    subs: subs({
      same: 'run install uninstall update lock sync graph',
      run: 'shell',
      check: 'check',
    }),
  },

  // ---- other package managers -------------------------------------------
  {
    id: 'bundle',
    label: 'bundle',
    activity: 'deps',
    runnerSubs: ['exec'],
    subs: subs({
      same: 'exec install update add remove lock outdated check config show list info binstubs clean cache',
    }),
  },
  {
    id: 'composer',
    label: 'composer',
    activity: 'deps',
    scripts: true,
    scriptNext: ['run', 'run-script'],
    runnerSubs: ['exec'],
    subs: subs({
      same: 'install update require remove dump-autoload outdated show audit run run-script exec',
      run: 'create-project init',
      check: 'validate',
    }),
  },
  {
    id: 'rustup',
    label: 'rustup',
    activity: 'deps',
    runnerSubs: ['run'],
    runnerSkip: { run: 1 },
    subs: subs({
      same: 'run update install default show toolchain target component override self doc which',
    }),
  },
  {
    id: 'mise',
    label: 'mise',
    activity: 'deps',
    runnerSubs: ['exec', 'x'],
    subs: subs({
      same: 'exec x install use ls list current trust settings plugins doctor',
    }),
  },
  {
    id: 'asdf',
    label: 'asdf',
    activity: 'deps',
    runnerSubs: ['exec'],
    subs: subs({
      same: 'exec install list current global local plugin reshim',
    }),
  },
  {
    id: 'direnv',
    label: 'direnv',
    activity: 'system',
    runnerSubs: ['exec'],
    runnerSkip: { exec: 1 },
    subs: subs({ same: 'exec allow deny reload status' }),
  },

  // ---- containers and infrastructure --------------------------------------
  {
    id: 'docker',
    label: 'docker',
    activity: 'infra',
    valueOptions: DOCKER_OPTIONS,
    subs: DOCKER_SUBS,
  },
  {
    id: 'podman',
    label: 'podman',
    activity: 'infra',
    valueOptions: DOCKER_OPTIONS,
    subs: DOCKER_SUBS,
  },
  {
    id: 'kubectl',
    label: 'kubectl',
    activity: 'infra',
    valueOptions: [
      '-n',
      '--namespace',
      '--context',
      '--kubeconfig',
      '--cluster',
      '--user',
      '-s',
      '--server',
      '--as',
      '--token',
    ],
    subs: subs({
      same: `get|describe|apply|delete|logs|exec|port-forward|rollout
        |rollout status|rollout restart|rollout undo|rollout history|scale
        |create|edit|patch|top|config|config use-context|config get-contexts
        |config current-context|config view|config set-context|cp|run|expose
        |label|annotate|wait|diff|kustomize|auth|api-resources|api-versions
        |cluster-info|version|explain|drain|cordon|uncordon|taint|attach|debug
        |events|proxy|replace|set|autoscale|certificate|plugin|completion`,
    }),
  },
  {
    id: 'helm',
    label: 'helm',
    activity: 'infra',
    valueOptions: ['-n', '--namespace', '--kube-context', '--kubeconfig'],
    subs: subs({
      same: `install|upgrade|uninstall|list|ls|repo|repo add|repo update
        |repo list|template|status|rollback|get|show|search|pull|push
        |dependency|create|history|diff|plugin|version|env`,
      check: 'lint',
      build: 'package',
      test: 'test',
    }),
  },
  {
    id: 'terraform',
    label: 'terraform',
    activity: 'infra',
    subs: TERRAFORM_SUBS,
  },
  { id: 'tofu', label: 'tofu', activity: 'infra', subs: TERRAFORM_SUBS },
  {
    id: 'wsl',
    label: 'wsl',
    activity: 'infra',
    runner: true,
    valueOptions: ['-d', '--distribution', '-u', '--user', '--cd'],
  },

  // ---- platform CLIs ------------------------------------------------------
  {
    id: 'supabase',
    label: 'supabase',
    activity: 'cloud',
    valueOptions: [
      '--workdir',
      '--project-ref',
      '--db-url',
      '--dns-resolver',
      '--network-id',
    ],
    subs: subs({
      infra: 'start stop status services',
      data: `db|db reset|db push|db pull|db diff|db dump|db lint|db start
        |db remote|db branch|db test|migration|migration new|migration up
        |migration list|migration repair|migration squash|migration fetch
        |migration down|gen|gen types|gen keys|gen signing-key|inspect
        |inspect db|seed`,
      test: 'test|test db|test new',
      same: `functions|functions deploy|functions new|functions delete
        |functions list|functions download|secrets|secrets set|secrets list
        |secrets unset|projects|projects list|projects create
        |projects api-keys|link|unlink|login|logout|branches|storage|domains
        |orgs|sso|postgres-config|snippets|bootstrap|config|config push`,
      run: 'init|functions serve',
    }),
  },
  {
    id: 'vercel',
    label: 'vercel',
    activity: 'cloud',
    valueOptions: [
      '--cwd',
      '--token',
      '-t',
      '--scope',
      '-S',
      '--local-config',
      '-A',
      '--global-config',
      '-Q',
    ],
    subs: subs({
      same: `deploy|env|env pull|env add|env ls|env rm|link|pull|logs|inspect
        |ls|list|rm|remove|promote|rollback|redeploy|domains|dns|certs|alias
        |secrets|project|projects|teams|switch|whoami|login|logout|bisect|git
        |integration|blob|telemetry`,
      run: 'dev init',
      build: 'build',
    }),
  },
  {
    id: 'aws',
    label: 'aws',
    activity: 'cloud',
    valueOptions: [
      '--profile',
      '--region',
      '--output',
      '--endpoint-url',
      '--query',
      '--color',
    ],
    subs: subs({
      same: `s3 s3api ec2 lambda iam sts cloudformation ecs ecr eks logs ssm
        dynamodb rds sqs sns secretsmanager cloudwatch route53 apigateway
        apigatewayv2 configure sso kms ses sesv2 events stepfunctions
        cloudfront amplify cognito-idp bedrock bedrock-runtime sagemaker glue
        athena kinesis elasticache elbv2 autoscaling codebuild codepipeline
        codecommit organizations ce budgets batch emr opensearch redshift efs
        backup acm wafv2 appsync cloudtrail`,
    }),
  },
  {
    id: 'gcloud',
    label: 'gcloud',
    activity: 'cloud',
    valueOptions: [
      '--project',
      '--account',
      '--configuration',
      '--format',
      '--region',
      '--zone',
      '--verbosity',
    ],
    subs: subs({
      same: `compute container run functions app auth config projects iam
        storage sql pubsub logging builds artifacts secrets services dns kms
        deploy firestore bigtable spanner scheduler tasks beta alpha components
        init info version`,
    }),
  },
  {
    id: 'az',
    label: 'az',
    activity: 'cloud',
    valueOptions: ['--subscription', '-o', '--output', '--query'],
    subs: subs({
      same: `login logout account group vm storage webapp functionapp aks acr
        ad keyvault network monitor deployment resource role sql cosmosdb
        containerapp appservice devops pipelines repos boards extension config
        configure version rest bicep staticwebapp postgres mysql redis
        servicebus eventhubs apim cdn dns iot signalr ml cognitiveservices
        search logicapp policy tag lock feature provider upgrade`,
    }),
  },
  {
    id: 'stripe',
    label: 'stripe',
    activity: 'cloud',
    subs: subs({
      same: `trigger|login|logs|logs tail|events|customers|products|prices
        |payment_intents|subscriptions|invoices|webhook_endpoints|config
        |status|samples|fixtures|open|get|post|delete|resources|version`,
      run: 'listen',
    }),
  },
  {
    id: 'wrangler',
    label: 'wrangler',
    activity: 'cloud',
    subs: subs({
      same: `deploy|publish|tail|login|logout|whoami|kv|r2|pages|pages deploy
        |pages project|secret|secret put|secret list|secret delete|queues
        |versions|deployments|rollback|hyperdrive|vectorize|ai|workflows
        |containers|docs`,
      run: 'dev|init|pages dev',
      data: 'd1|d1 execute|d1 migrations|d1 create|d1 list|d1 export',
      build: 'types',
      check: 'check',
    }),
  },
  {
    id: 'firebase',
    label: 'firebase',
    activity: 'cloud',
    valueOptions: ['--project', '-P', '--config', '-c', '--only', '--except'],
    subs: subs({
      same: `deploy login logout use projects:list functions:log
        hosting:channel:deploy apps:list firestore:indexes ext:install`,
      run: 'serve init emulators:start functions:shell',
      test: 'emulators:exec',
      data: 'firestore:delete database:get database:set',
    }),
  },
  {
    id: 'netlify',
    label: 'netlify',
    activity: 'cloud',
    subs: subs({
      same: 'deploy init link unlink login logout status env open sites logs blobs recipes functions',
      run: 'dev serve',
      build: 'build',
    }),
  },
  {
    id: 'fly',
    label: 'fly',
    activity: 'cloud',
    subs: subs({
      same: `deploy|launch|status|logs|ssh|ssh console|ssh sftp|secrets
        |secrets set|secrets list|secrets unset|apps|apps list|apps create
        |apps destroy|machine|scale|volumes|postgres|redis|proxy|auth|config
        |releases|regions|ips|certs|doctor|version|open|ping|console|image
        |checks|tokens|wireguard`,
    }),
  },
  {
    id: 'heroku',
    label: 'heroku',
    activity: 'cloud',
    subs: subs({
      same: `logs run ps config config:set config:get apps addons pg releases
        restart open login create domains git:remote container:push
        container:release maintenance:on maintenance:off`,
      data: 'pg:psql',
      run: 'local',
    }),
  },

  // ---- web frameworks and build tools ---------------------------------------
  {
    id: 'next',
    label: 'next',
    activity: 'run',
    subs: subs({
      run: 'dev start',
      build: 'build export typegen',
      check: 'lint',
      system: 'info telemetry',
    }),
  },
  {
    id: 'vite',
    label: 'vite',
    activity: 'run',
    subs: subs({ run: 'dev serve preview', build: 'build optimize' }),
  },
  {
    id: 'nuxt',
    label: 'nuxt',
    activity: 'run',
    subs: subs({
      run: 'dev preview init add',
      build: 'build generate prepare analyze',
      check: 'typecheck',
      deps: 'upgrade',
      system: 'cleanup info',
    }),
  },
  {
    id: 'astro',
    label: 'astro',
    activity: 'run',
    subs: subs({
      run: 'dev preview',
      build: 'build sync',
      check: 'check',
      deps: 'add',
      system: 'info',
    }),
  },
  {
    id: 'storybook',
    label: 'storybook',
    activity: 'run',
    subs: subs({
      run: 'dev init add sandbox',
      build: 'build index',
      deps: 'upgrade',
      check: 'doctor automigrate',
    }),
  },
  {
    id: 'tauri',
    label: 'tauri',
    activity: 'build',
    subs: subs({
      run: 'dev init',
      build: 'build bundle icon',
      system: 'info',
      deps: 'add',
      devices: 'android ios',
    }),
  },
  {
    id: 'ng',
    label: 'ng',
    activity: 'build',
    subs: subs({
      run: 'serve s generate g new',
      build: 'build b',
      test: 'test t e2e e',
      check: 'lint',
      deps: 'add update',
      system: 'version config cache analytics',
    }),
  },
  {
    id: 'nest',
    label: 'nest',
    activity: 'build',
    subs: subs({
      run: 'start generate g new n',
      build: 'build',
      deps: 'add update',
      system: 'info',
    }),
  },
  {
    id: 'expo',
    label: 'expo',
    activity: 'run',
    subs: subs({
      run: 'start|run|run android|run ios|run:android|run:ios|customize|config|register',
      build: 'export prebuild build build:android build:ios',
      deps: 'install upgrade',
      check: 'doctor lint',
      cloud: 'login logout whoami publish',
    }),
  },
  {
    id: 'eas',
    label: 'eas',
    activity: 'cloud',
    subs: subs({
      build: 'build build:list build:view build:run',
      same: `submit update update:list login logout whoami init credentials
        device channel branch secret env metadata config diagnostics project
        account webhook workflow deploy analytics`,
    }),
  },
  {
    id: 'react-native',
    label: 'react-native',
    activity: 'run',
    subs: subs({
      run: 'start run-android run-ios',
      build: 'bundle build-android build-ios codegen',
      check: 'doctor',
      system: 'info config clean',
      devices: 'log-android log-ios',
    }),
  },
  {
    id: 'rails',
    label: 'rails',
    activity: 'run',
    subs: subs({
      run: 'server s console c generate g runner new',
      test: 'test t',
      data: `db:migrate db:seed db:reset db:create db:drop db:setup db:rollback
        db:schema:load db:prepare`,
      build: 'assets:precompile',
      explore: 'routes',
    }),
  },

  // ---- test, check, data ------------------------------------------------------
  {
    id: 'vitest',
    label: 'vitest',
    activity: 'test',
    subs: subs({
      same: 'run watch dev related bench list',
      check: 'typecheck',
      run: 'init',
    }),
  },
  {
    id: 'playwright',
    label: 'playwright',
    activity: 'test',
    subs: subs({
      same: 'test merge-reports',
      deps: 'install install-deps uninstall',
      run: 'show-report show-trace codegen open screenshot pdf',
      system: 'clear-cache',
    }),
  },
  {
    id: 'cypress',
    label: 'cypress',
    activity: 'test',
    subs: subs({
      same: 'run',
      run: 'open',
      deps: 'install',
      check: 'verify',
      system: 'cache info version',
    }),
  },
  {
    id: 'biome',
    label: 'biome',
    activity: 'check',
    subs: subs({
      same: 'check lint format ci migrate rage explain search start stop clean version',
      run: 'init',
    }),
  },
  {
    id: 'ruff',
    label: 'ruff',
    activity: 'check',
    subs: subs({
      same: 'check format rule config linter clean server analyze version',
    }),
  },
  {
    id: 'prisma',
    label: 'prisma',
    activity: 'data',
    subs: subs({
      same: `migrate|migrate dev|migrate deploy|migrate reset|migrate status
        |migrate resolve|migrate diff|db|db push|db pull|db seed|db execute
        |version|debug`,
      build: 'generate',
      run: 'studio init',
      check: 'format validate',
    }),
  },
  {
    id: 'drizzle-kit',
    label: 'drizzle-kit',
    activity: 'data',
    subs: subs({
      same: 'generate migrate push pull up drop export introspect',
      run: 'studio',
      check: 'check',
    }),
  },
  {
    id: 'openspec',
    label: 'openspec',
    activity: 'agent',
    subs: subs({
      same: 'list show status new init update archive instructions view diff change spec schema config completion',
      check: 'validate',
    }),
  },

  // ---- devices ------------------------------------------------------------------
  {
    id: 'adb',
    label: 'adb',
    activity: 'devices',
    valueOptions: ['-s', '-H', '-P', '-t', '-L'],
    subs: subs({
      same: `devices shell install uninstall logcat push pull forward reverse
        connect disconnect kill-server start-server reboot root tcpip emu
        exec-out wait-for-device get-state bugreport sideload pair version`,
    }),
  },
  {
    id: 'xcrun',
    label: 'xcrun',
    activity: 'devices',
    runner: true,
    valueOptions: ['--sdk', '--toolchain'],
  },
  {
    id: 'simctl',
    label: 'simctl',
    activity: 'devices',
    subs: subs({
      same: 'list boot shutdown install launch io erase openurl terminate uninstall spawn',
    }),
  },

  // ---- interpreters and shells -----------------------------------------------------
  {
    id: 'node',
    label: 'node',
    activity: 'run',
    valueOptions: [
      '-r',
      '--require',
      '--import',
      '--loader',
      '--experimental-loader',
      '-C',
      '--conditions',
    ],
    interpreter: { inline: ['-e', '--eval', '-p', '--print'] },
    activityFlags: { '--test': 'test', '--check': 'check' },
  },
  {
    id: 'tsx',
    label: 'tsx',
    activity: 'run',
    interpreter: { inline: ['-e', '--eval'] },
  },
  {
    id: 'ts-node',
    label: 'ts-node',
    activity: 'run',
    interpreter: { inline: ['-e', '--eval', '-p', '--print'] },
  },
  {
    id: 'ruby',
    label: 'ruby',
    activity: 'run',
    valueOptions: ['-r', '-I'],
    interpreter: { inline: ['-e', '-ne', '-pe'] },
  },
  {
    id: 'php',
    label: 'php',
    activity: 'run',
    valueOptions: ['-d', '-c', '-S', '-t'],
    interpreter: { inline: ['-r'] },
  },
  {
    id: 'perl',
    label: 'perl',
    activity: 'run',
    valueOptions: ['-I', '-M'],
    interpreter: {
      inline: [
        '-e',
        '-E',
        '-ne',
        '-pe',
        '-pi',
        '-lne',
        '-lpe',
        '-0pe',
        '-0ne',
        '-i',
      ],
    },
  },
  { id: 'bash', label: 'bash', activity: 'run', shell: POSIX_SHELL },
  { id: 'sh', label: 'sh', activity: 'run', shell: POSIX_SHELL },
  { id: 'zsh', label: 'zsh', activity: 'run', shell: POSIX_SHELL },
  { id: 'dash', label: 'dash', activity: 'run', shell: POSIX_SHELL },
  { id: 'ksh', label: 'ksh', activity: 'run', shell: POSIX_SHELL },
  { id: 'fish', label: 'fish', activity: 'run', shell: POSIX_SHELL },
  {
    id: 'powershell',
    label: 'powershell',
    activity: 'run',
    shell: { dialect: 'powershell', flags: ['-command', '-c'] },
  },
  {
    id: 'cmd',
    label: 'cmd',
    activity: 'run',
    shell: { dialect: 'posix', flags: ['/c', '/k'], rest: true },
  },

  // ---- pseudo-tool for files run by path -------------------------------------------
  { id: 'script', label: 'project script', activity: 'run' },
];

/** Tools known by name only. */
const SIMPLE: ToolDef[] = [
  ...simple(
    'system',
    `cd pushd popd export set unset source echo printf sleep wait true false
    test read local declare typeset readonly alias unalias shopt trap umask
    eval hash history jobs fg bg disown pwd clear setx title rem chcp setlocal
    endlocal pause Set-Location Push-Location Pop-Location Write-Host
    Write-Output Write-Error Write-Verbose Write-Warning Write-Debug
    Write-Information Start-Sleep Out-Null Get-Location Set-StrictMode
    Import-Module Set-Variable Remove-Variable Clear-Host Out-Default Set-Alias`,
    { plumbing: true },
  ),
  ...simple(
    'explore',
    `grep egrep fgrep rg ag ack fd find findstr ls tree cat bat head tail less
    more sed awk gawk cut sort uniq wc tr tee jq yq xq diff cmp comm column
    paste rev nl fold od xxd hexdump strings file stat which whereis realpath
    readlink basename dirname date cal base64 md5sum sha1sum sha256sum
    sha512sum shasum cksum pdftotext pdfinfo exiftool identify man tldr
    printenv locale getconf seq expr bc numfmt shuf tac zcat zgrep lsd eza
    Get-ChildItem Get-Content Select-String Select-Object Where-Object
    ForEach-Object Sort-Object Measure-Object Group-Object Format-Table
    Format-List Format-Wide Out-String Out-Host ConvertFrom-Json ConvertTo-Json
    ConvertFrom-Csv ConvertTo-Csv Import-Csv Get-Item Get-ItemProperty
    Test-Path Resolve-Path Split-Path Join-Path Get-Command Get-Date
    Get-FileHash Get-Member Compare-Object Get-Help Get-Unique Tee-Object
    Get-Variable Get-Alias Get-Module Get-History Get-Clipboard Select-Xml
    Get-Culture Get-Host Get-Random New-TimeSpan Measure-Command`,
    { utility: true },
  ),
  ...simple(
    'system',
    `rm rmdir cp mv mkdir touch chmod chown chgrp ln tar zip unzip gzip gunzip
    bzip2 xz zstd 7z 7za dd mktemp truncate rimraf du df free uptime uname
    whoami hostname id ps pgrep pkill kill killall top htop lsof netstat ss
    lsblk mount umount systemctl service journalctl launchctl crontab sysctl
    nproc lscpu ulimit env sudo xargs open xdg-open pbcopy pbpaste clip xclip
    code cursor tasklist taskkill wmic powercfg fsutil sc reg schtasks netsh
    ipconfig ifconfig ip route arp icacls attrib robocopy xcopy takeown
    cygpath wslpath mklink explorer certutil sw_vers defaults diskutil hdiutil
    plutil codesign xattr security gpg tmux screen
    Remove-Item Copy-Item Move-Item New-Item Rename-Item Set-Content
    Add-Content Clear-Content Out-File Export-Csv Expand-Archive
    Compress-Archive Get-Acl Set-Acl Get-Process Stop-Process Start-Process
    Wait-Process Get-Service Start-Service Stop-Service Restart-Service
    Get-CimInstance Get-WmiObject Get-NetTCPConnection Get-NetAdapter
    Get-NetIPAddress Get-PSDrive Get-PnpDevice Get-PnpDeviceProperty
    Get-ComputerInfo Get-EventLog Get-WinEvent Start-Job Wait-Job Receive-Job
    Get-Job Stop-Job Remove-Job Add-Type New-Object Invoke-Expression
    Invoke-Command Set-ExecutionPolicy Get-ExecutionPolicy Set-Item
    Set-ItemProperty New-ItemProperty Remove-ItemProperty Get-Volume Get-Disk
    Get-ScheduledTask Unblock-File Set-Clipboard Get-AppxPackage Get-HotFix
    Get-LocalUser Get-TimeZone New-PSDrive`,
    { utility: true },
  ),
  ...simple(
    'web',
    `curl wget http xh ssh scp sftp rsync nc ncat netcat telnet ping traceroute
    tracert dig nslookup host whois openssl ngrok cloudflared websocat grpcurl
    ftp mosh ssh-keygen ssh-add ssh-keyscan Invoke-WebRequest
    Invoke-RestMethod Resolve-DnsName Test-NetConnection Test-Connection`,
  ),
  ...simple(
    'vcs',
    `glab hub svn hg jj tig lazygit git-lfs gitk git-filter-repo changeset
    standard-version git-cliff`,
  ),
  ...simple(
    'deps',
    `conda mamba micromamba brew apt apt-get dpkg yum dnf pacman apk snap
    flatpak winget choco scoop gem nuget pod carthage corepack nvm fnm volta
    pyenv rbenv sdk patch-package syncpack ncu yalc virtualenv venv`,
  ),
  ...simple(
    'build',
    `webpack rollup esbuild swc tsup unbuild parcel ninja meson cmake msbuild
    bazel buck ant sbt rustc javac kotlinc swiftc clang clang++ gcc g++ cc c++
    ld ar protoc buf wasm-pack sass postcss tailwindcss babel electron-builder
    electron-forge pyinstaller python-build maturin cibuildwheel lipo
    pkg-config autoconf automake svelte-kit gatsby hugo jekyll eleventy
    docusaurus vitepress mkdocs sphinx-build typedoc jsdoc ionic cap vue
    vue-cli-service react-scripts craco rspack rsbuild ncc tsdown rolldown
    lightningcss terser svgo pandoc latexmk pdflatex xelatex mmdc
    openapi-generator lerna`,
  ),
  ...simple(
    'test',
    `jest mocha ava tap jasmine karma pytest tox nox unittest coverage nyc c8
    rspec phpunit pest k6 newman artillery lighthouse lhci bats ctest gotestsum
    cargo-nextest detox maestro testcafe wdio chromatic percy robot behave
    cucumber cucumber-js locust ab wrk hey autocannon hyperfine`,
  ),
  ...simple(
    'check',
    `eslint prettier oxlint stylelint tsc tsgo vue-tsc svelte-check black isort
    flake8 pylint mypy pyright basedpyright bandit shellcheck shfmt hadolint
    yamllint markdownlint markdownlint-cli2 actionlint commitlint knip depcheck
    ts-prune madge publint attw size-limit cspell codespell typos
    golangci-lint gofmt goimports staticcheck rustfmt cargo-clippy cargo-deny
    cargo-audit ktlint detekt swiftlint swiftformat rubocop phpstan psalm
    php-cs-fixer clang-format clang-tidy cppcheck sqlfluff tflint tfsec checkov
    trivy semgrep snyk gitleaks trufflehog dprint lychee vale
    editorconfig-checker pre-commit husky lefthook lint-staged license-checker
    standard xo jshint jsonlint taplo htmlhint html-validate pa11y
    dotenv-linter kubeval kubeconform conftest grype syft osv-scanner pip-audit
    safety brakeman credo hlint stylua spectral redocly ajv`,
  ),
  ...simple(
    'infra',
    `nerdctl buildah skopeo k9s kustomize minikube kind k3d k3s kubectx kubens
    stern skaffold tilt terragrunt pulumi ansible ansible-playbook
    ansible-galaxy vagrant packer nomad consul vault colima limactl multipass
    act ctr crictl dive lazydocker argocd flux istioctl eksctl kops kubeadm oc
    cdktf`,
  ),
  ...simple(
    'cloud',
    `gsutil bq doctl linode-cli oci ibmcloud railway render amplify sst
    serverless cdk sam twilio sentry-cli datadog-ci appcenter semantic-release
    release-it np twine pscale neonctl turso upstash convex sanity shopify
    codecov coveralls sonar-scanner vsce ovsx cf`,
  ),
  ...simple(
    'data',
    `psql pg_dump pg_restore pg_isready pg_ctl createdb dropdb initdb mysql
    mysqldump mariadb sqlite3 sqlcmd bcp mongosh mongo mongodump mongorestore
    mongoexport mongoimport redis-cli redis-server clickhouse-client
    clickhouse duckdb cqlsh influx knex sequelize typeorm alembic flyway
    liquibase dbmate atlas goose migrate sqlx diesel dbt hasura pgcli mycli
    litecli usql pgbench sqlplus cockroach etcdctl mc`,
  ),
  ...simple(
    'devices',
    `emulator avdmanager sdkmanager fastboot instruments ios-deploy idevice_id
    ideviceinstaller idevicesyslog fastlane scrcpy apkanalyzer aapt aapt2
    bundletool apksigner zipalign jarsigner keytool devicectl xctrace appium`,
  ),
  ...simple(
    'run',
    `lua luajit java kotlin scala groovy rscript julia elixir erl ghc
    runhaskell stack cabal osascript nodemon pm2 forever concurrently
    npm-run-all wait-on serve http-server live-server jupyter ipython streamlit
    uvicorn gunicorn hypercorn flask django-admin celery electron chrome
    chromium google-chrome msedge firefox ffmpeg ffprobe magick convert gs
    inkscape yt-dlp degit cookiecutter yo plop hygen expect ts-node-dev
    tsc-watch vite-node esno jiti zx wasmtime`,
  ),
  ...simple(
    'agent',
    `claude codex opencode gemini aider cursor-agent amp runray ollama llm
    copilot crush qwen cline plandex sgpt mods`,
  ),
];

/** Every registry entry. */
export const TOOL_DEFS: readonly ToolDef[] = [...RICH, ...SIMPLE];

interface Alias {
  id: string;
  /** Words the alias implies before its own arguments. */
  prefix?: readonly string[];
}

/** Other program names for an entry. */
export const TOOL_ALIASES: Readonly<Record<string, Alias>> = {
  'docker-compose': { id: 'docker', prefix: ['compose'] },
  'podman-compose': { id: 'podman', prefix: ['compose'] },
  python3: { id: 'python' },
  py: { id: 'python' },
  pip3: { id: 'pip' },
  nodejs: { id: 'node' },
  pwsh: { id: 'powershell' },
  gradlew: { id: 'gradle' },
  mvnw: { id: 'mvn' },
  flyctl: { id: 'fly' },
  nuxi: { id: 'nuxt' },
  sls: { id: 'serverless' },
  httpie: { id: 'http' },
  ripgrep: { id: 'rg' },
  gsed: { id: 'sed' },
  ggrep: { id: 'grep' },
  dir: { id: 'ls' },
  type: { id: 'cat' },
  where: { id: 'which' },
  del: { id: 'rm' },
  erase: { id: 'rm' },
  copy: { id: 'cp' },
  move: { id: 'mv' },
  md: { id: 'mkdir' },
  rd: { id: 'rmdir' },
  ren: { id: 'rename-item' },
  chdir: { id: 'cd' },
  cls: { id: 'clear' },
  start: { id: 'start-process' },
  'run-s': { id: 'npm-run-all' },
  'run-p': { id: 'npm-run-all' },
  // PowerShell aliases that are not also POSIX program names
  sl: { id: 'set-location' },
  gci: { id: 'get-childitem' },
  gc: { id: 'get-content' },
  select: { id: 'select-object' },
  ft: { id: 'format-table' },
  fl: { id: 'format-list' },
  gi: { id: 'get-item' },
  gp: { id: 'get-itemproperty' },
  gcm: { id: 'get-command' },
  gm: { id: 'get-member' },
  measure: { id: 'measure-object' },
  group: { id: 'group-object' },
  compare: { id: 'compare-object' },
  ri: { id: 'remove-item' },
  cpi: { id: 'copy-item' },
  mi: { id: 'move-item' },
  ni: { id: 'new-item' },
  rni: { id: 'rename-item' },
  gps: { id: 'get-process' },
  spps: { id: 'stop-process' },
  saps: { id: 'start-process' },
  gsv: { id: 'get-service' },
  gcim: { id: 'get-ciminstance' },
  gwmi: { id: 'get-wmiobject' },
  iex: { id: 'invoke-expression' },
  icm: { id: 'invoke-command' },
  iwr: { id: 'invoke-webrequest' },
  irm: { id: 'invoke-restmethod' },
  tnc: { id: 'test-netconnection' },
};

/** npm package names whose binary has another name (`npx typescript`). */
export const PACKAGE_ALIASES: Readonly<Record<string, string>> = {
  typescript: 'tsc',
  '@typescript/native-preview': 'tsgo',
  '@biomejs/biome': 'biome',
  '@changesets/cli': 'changeset',
  '@playwright/test': 'playwright',
  '@angular/cli': 'ng',
  '@nestjs/cli': 'nest',
  '@vue/cli': 'vue',
  'firebase-tools': 'firebase',
  'netlify-cli': 'netlify',
  '@tauri-apps/cli': 'tauri',
  '@expo/cli': 'expo',
  'expo-cli': 'expo',
  'eas-cli': 'eas',
  '@sentry/cli': 'sentry-cli',
  'aws-cdk': 'cdk',
  '@aws-amplify/cli': 'amplify',
  '@storybook/cli': 'storybook',
  sb: 'storybook',
  '@tailwindcss/cli': 'tailwindcss',
  '@swc/cli': 'swc',
  '@babel/cli': 'babel',
  'markdownlint-cli': 'markdownlint',
  '@commitlint/cli': 'commitlint',
  '@fission-ai/openspec': 'openspec',
  '@anthropic-ai/claude-code': 'claude',
  '@openai/codex': 'codex',
  'opencode-ai': 'opencode',
  '@google/gemini-cli': 'gemini',
  'npm-check-updates': 'ncu',
  '@arethetypeswrong/cli': 'attw',
  '@redocly/cli': 'redocly',
  '@openapitools/openapi-generator-cli': 'openapi-generator',
  '@stoplight/spectral-cli': 'spectral',
  '@lhci/cli': 'lhci',
  '@vscode/vsce': 'vsce',
  '@sanity/cli': 'sanity',
  '@shopify/cli': 'shopify',
  '@upstash/cli': 'upstash',
  '@react-native-community/cli': 'react-native',
  '@ionic/cli': 'ionic',
  '@capacitor/cli': 'cap',
  '@sveltejs/kit': 'svelte-kit',
  '@nuxt/cli': 'nuxt',
  'gatsby-cli': 'gatsby',
  '@docusaurus/core': 'docusaurus',
  '@11ty/eleventy': 'eleventy',
  'sequelize-cli': 'sequelize',
  '@mermaid-js/mermaid-cli': 'mmdc',
  '@cucumber/cucumber': 'cucumber-js',
  '@wdio/cli': 'wdio',
};

/** Python module names run with `-m` whose tool has another name. */
export const MODULE_ALIASES: Readonly<Record<string, string>> = {
  'http.server': 'http-server',
  build: 'python-build',
  django: 'django-admin',
  pre_commit: 'pre-commit',
  ensurepip: 'pip',
  pip_audit: 'pip-audit',
  pyinstaller: 'pyinstaller',
  sphinx: 'sphinx-build',
};

const BY_ID: ReadonlyMap<string, ToolDef> = (() => {
  const map = new Map<string, ToolDef>();
  for (const def of TOOL_DEFS) if (!map.has(def.id)) map.set(def.id, def);
  return map;
})();

/** Sorted registry ids: the closed vocabulary of `runray.tool`. */
export const TOOL_IDS: readonly string[] = [...BY_ID.keys()].sort();

const VERSIONED = /^(python|pip|node|ruby|php|perl|java)[0-9][0-9.]*$/;

export interface ToolMatch {
  def: ToolDef;
  /** Words an alias implies before the arguments (`docker-compose` → `compose`). */
  prefix: readonly string[];
}

/** The registry entry for a normalised program name, if it has one. */
export function lookupTool(name: string): ToolMatch | undefined {
  const direct = BY_ID.get(name);
  if (direct !== undefined) return { def: direct, prefix: [] };
  if (Object.hasOwn(TOOL_ALIASES, name)) {
    const alias = TOOL_ALIASES[name] as Alias;
    const def = BY_ID.get(alias.id);
    if (def !== undefined) return { def, prefix: alias.prefix ?? [] };
  }
  const versioned = VERSIONED.exec(name); // python3.12, pip3.11, node20
  if (versioned !== null) {
    const def = BY_ID.get(versioned[1] as string);
    if (def !== undefined) return { def, prefix: [] };
  }
  return undefined;
}

/** Registry entry by id. */
export function toolById(id: string): ToolDef | undefined {
  return BY_ID.get(id);
}

/** Display label of a tool id; the id itself for an unknown one. */
export function toolLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/**
 * Every value `runray.toolVia` can take: runner programs, runner
 * subcommands, module flags and shells handed a command string.
 */
export const RUNNER_IDS: readonly string[] = (() => {
  const out = new Set<string>();
  for (const def of BY_ID.values()) {
    if (def.runner === true) out.add(def.id);
    for (const sub of def.runnerSubs ?? []) out.add(`${def.id} ${sub}`);
    if (def.moduleFlag !== undefined) out.add(`${def.id} ${def.moduleFlag}`);
    if (def.shell !== undefined) out.add(`${def.id} ${def.shell.flags[0]}`);
  }
  return [...out].sort();
})();

const SCRIPT_PATTERNS: ReadonlyArray<readonly [RegExp, Activity]> = [
  [/^(test|tests|e2e|spec|unit|integration)/, 'test'],
  [/^(build|compile|bundle|assemble|dist)/, 'build'],
  [
    /^(lint|format|fmt|typecheck|type-check|types-check|check|verify|validate|prettier|eslint|tsc)/,
    'check',
  ],
  [/^(db|migrat|seed|prisma|drizzle)/, 'data'],
  [/^(dev|start|serve|preview|watch)$/, 'run'],
];

/**
 * Activity of a user-defined script or task name (`test:e2e`, `db:reset`,
 * `assembleDebug`). Colon-separated segments are read left to right and the
 * first one that matches a pattern decides; the default is `run`.
 */
export function scriptActivity(name: string): Activity {
  for (const segment of name.toLowerCase().split(':')) {
    if (segment === '') continue;
    for (const [pattern, activity] of SCRIPT_PATTERNS) {
      if (pattern.test(segment)) return activity;
    }
  }
  return 'run';
}

/** How a harness tool takes part in a session. */
export interface HarnessTool {
  activity: Activity;
  /** `shell`: its input is a command; `skill`, `agent`: it names what it runs. */
  role?: 'shell' | 'skill' | 'agent';
}

function harness(
  activity: Activity,
  names: string,
  role?: HarnessTool['role'],
): Array<[string, HarnessTool]> {
  return list(names).map((name) => [
    name,
    role === undefined ? { activity } : { activity, role },
  ]);
}

/**
 * Harness tools by exact name. Claude Code names are PascalCase, OpenCode
 * and other harnesses use lowercase or snake_case, so one table serves
 * every source without a per-source switch.
 */
export const HARNESS_TOOLS: ReadonlyMap<string, HarnessTool> = new Map([
  ...harness(
    'other',
    'Bash PowerShell bash shell run_shell_command exec_command local_shell',
    'shell',
  ),
  ...harness(
    'explore',
    `Read Glob Grep LS LSP NotebookRead BashOutput TaskOutput read glob grep
    list read_file read_many_files list_directory search_file_content
    view_image`,
  ),
  ...harness(
    'edit',
    `Edit Write MultiEdit NotebookEdit edit write patch apply_patch multiedit
    write_file replace`,
  ),
  ...harness(
    'web',
    'WebFetch WebSearch webfetch websearch web_fetch google_web_search',
  ),
  ...harness('agent', 'Agent Task task', 'agent'),
  ...harness('agent', 'Skill skill', 'skill'),
  ...harness(
    'agent',
    `TodoWrite TodoRead TaskCreate TaskUpdate TaskList TaskGet TaskStop
    KillShell KillBash EnterPlanMode ToolSearch SendMessage Workflow
    SlashCommand Monitor ScheduleWakeup EnterWorktree ExitWorktree
    StructuredOutput SubagentHandback todowrite todoread update_plan`,
  ),
  ...harness('human', 'AskUserQuestion ExitPlanMode question'),
  ...harness('integration', 'ListMcpResourcesTool ReadMcpResourceTool'),
]);

/** Activity of a harness tool by name; `other` for a name outside the table. */
export function harnessActivity(name: string): Activity {
  return HARNESS_TOOLS.get(name)?.activity ?? 'other';
}
