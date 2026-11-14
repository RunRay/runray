# Delta for visualizer

## ADDED Requirements

### Requirement: Codex is presented as a named source
Wherever the dashboard tells sources apart, a Codex run SHALL appear under
its source id `codex`, as the other sources appear under theirs: an option
in the source filter when Codex runs are loaded, a segment and legend entry
with its own colour in by-source charts, and a colour that holds in both
themes. It SHALL NOT fall into the colour used for an unrecognised source.

#### Scenario: By-source chart
- GIVEN Claude Code, OpenCode and Codex runs loaded
- WHEN the by-source breakdown renders
- THEN it shows three segments with three distinct colours and the legend
  entry `codex` on the third

#### Scenario: Source filter
- GIVEN a trace with Codex runs
- WHEN the person filters by source `codex`
- THEN only Codex runs remain, and the filter survives a reload through the
  URL

#### Scenario: Both themes
- GIVEN the by-source legend in the light and in the dark theme
- WHEN contrast of the Codex colour against its surface is measured
- THEN it meets the same threshold the other source colours meet

### Requirement: Per-source hints cover Codex
Hints that the Waste tab and the cost surfaces word per source SHALL have
Codex wording: the instructions file is `AGENTS.md`, a resume hint names a
way to continue a Codex thread, and the note that cost is computed from the
recorded transcript SHALL show on Codex runs. A Codex run SHALL NOT get the
custom-agent wording.

#### Scenario: Dead-end lever
- GIVEN a Codex run with a `dead-end-run` group in the Waste tab
- WHEN its lever is rendered
- THEN it tells the person how to continue the Codex thread and does not
  mention returning an error to a caller

#### Scenario: Transcript cost note
- GIVEN a Codex run and a loaded pricing payload
- WHEN the pricing provenance renders
- THEN the note that the figure is a lower bound computed from the transcript
  is shown

#### Scenario: Welcome dialog names the sources read
- GIVEN the first live view of a trace that holds Codex runs
- WHEN the welcome dialog renders
- THEN its text does not say the logs came from Claude Code and OpenCode
  only

#### Scenario: Hook note
- GIVEN the tool table of a Codex run, which has no hook spans
- WHEN it renders
- THEN no hook rows and no hook note are shown
