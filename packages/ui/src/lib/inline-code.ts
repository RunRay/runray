/**
 * Playbook lines mark commands, keys and file names with backticks (the
 * registry test keeps them balanced). This splits one line into prose and
 * code runs so the Inspector can set the code runs in mono; a stray
 * unbalanced backtick renders literally rather than swallowing the rest.
 */
export interface InlineRun {
  code: boolean;
  text: string;
}

export function splitInlineCode(line: string): InlineRun[] {
  const parts = line.split('`');
  if (parts.length % 2 === 0) return [{ code: false, text: line }];
  const runs: InlineRun[] = [];
  parts.forEach((text, i) => {
    if (text.length === 0) return;
    runs.push({ code: i % 2 === 1, text });
  });
  return runs;
}
