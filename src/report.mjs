// Renders check results for people, for machines and for GitHub Actions.

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g;
const COMMAND_START_RE = /^[ \t]*::/gm;

const escapeData = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** The Actions runner executes any output line starting with "::": a contract must not be able to write one. */
export const neutralizeCommands = (text) => String(text).replace(COMMAND_START_RE, ': :');
const oneLine = (text) => neutralizeCommands(String(text).replace(CONTROL_CHARS_RE, ' '));

function humanLines(result) {
  if (result.sourceError) return [`  ! could not check: ${oneLine(result.sourceError)}`];
  if (result.report.ok) return [`  ok, ${result.report.itemCount} items`];
  return result.report.violations.map((violation) => `  x ${oneLine(violation.message)}`);
}

export function formatHuman(results) {
  const lines = results.flatMap((result) => [oneLine(result.name), ...humanLines(result)]);
  const broken = results.filter((result) => result.report && !result.report.ok).length;
  const unknown = results.filter((result) => result.sourceError).length;
  lines.push('', `${results.length} contract(s): ${results.length - broken - unknown} ok, ${broken} broken, ${unknown} could not be checked`);
  return lines.join('\n');
}

export function formatGithub(results) {
  return results.flatMap((result) => {
    const title = `driftprobe ${escapeProperty(result.name)}`;
    if (result.sourceError) return [`::error title=${title}::${escapeData(result.sourceError)}`];
    return result.report.violations.map(
      (violation) => `::error title=${title}::${escapeData(violation.message)}`,
    );
  }).join('\n');
}

export function exitCode(results) {
  if (results.some((result) => result.report && !result.report.ok)) return 1;
  return results.some((result) => result.sourceError) ? 2 : 0;
}
