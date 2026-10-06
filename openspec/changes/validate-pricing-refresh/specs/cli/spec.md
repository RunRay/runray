# Delta for cli

## ADDED Requirements

### Requirement: Pricing refresh accepts only a sound price list
`pricing --refresh` SHALL treat the downloaded price list as untrusted. It SHALL replace the user pricing override only when every check below passes, and SHALL replace it atomically. On any failure it SHALL leave the previous override byte-identical and say that nothing was written.

- **Limits.** The download SHALL be abandoned after 30 seconds without data, after 10 minutes in all, or once the body passes 32 MiB. A declared length over the cap SHALL be refused without reading the body. A connection failure SHALL name its cause.
- **Content.** An HTML page SHALL be refused. The body SHALL parse as JSON and SHALL be an object keyed by model.
- **Rates.** A chat model of a known provider with a published rate that is negative, not a finite number, or above $10,000 per million tokens SHALL be left out and reported by name with the reason. A missing or null rate means "not published".
- **Size.** The converted table SHALL hold at least half as many models as the bundled snapshot. With `--allow-short-list`, any non-empty table SHALL be accepted.

When reading the override, the system SHALL ignore a table that has no models or has a rate that is not a number of at least 0. It SHALL warn which field failed and use the bundled snapshot.

#### Scenario: Empty reply refused
- GIVEN an existing pricing override
- WHEN `pricing --refresh` receives `{}` or `[]`
- THEN the command fails, the override is byte-identical, and the output says nothing was written

#### Scenario: Endless reply cut off
- GIVEN a server that streams a body without end
- WHEN `pricing --refresh` reads it
- THEN reading stops once 32 MiB have arrived and the command fails without writing

#### Scenario: Corrupted rate left out
- GIVEN a price list where one Anthropic chat model has a negative output rate
- WHEN `pricing --refresh` runs
- THEN the override is written without that model, and stderr shows `warning: left out <model>: output_cost_per_token is negative`

#### Scenario: Empty override ignored
- GIVEN a pricing override whose `entries` is empty
- WHEN any command loads pricing
- THEN it warns that the override is invalid and prices runs from the bundled snapshot

#### Scenario: Stalled server cut off
- GIVEN a server that sends its headers and then no more data
- WHEN `pricing --refresh` reads the body
- THEN it stops after 30 seconds without data, says so, and writes nothing

#### Scenario: Short list accepted on request
- GIVEN a price list with fewer than half the bundled snapshot's models
- WHEN the user runs `pricing --refresh --allow-short-list`
- THEN the override is written with that list, while an empty list is still refused
