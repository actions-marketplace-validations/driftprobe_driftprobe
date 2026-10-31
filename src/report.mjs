// Renders check results for people, for machines and for GitHub Actions.

const escapeAnnotation = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function humanLines(result) {
  if (result.sourceError) return [`  ! could not check: ${result.sourceError}`];
  if (result.report.ok) return [`  ok, ${result.report.itemCount} items`];
  return result.report.violations.map((violation) => `  x ${violation.message}`);
}

export function formatHuman(results) {
  const lines = results.flatMap((result) => [result.name, ...humanLines(result)]);
  const broken = results.filter((result) => result.report && !result.report.ok).length;
  const unknown = results.filter((result) => result.sourceError).length;
  lines.push('', `${results.length} contract(s): ${results.length - broken - unknown} ok, ${broken} broken, ${unknown} could not be checked`);
  return lines.join('\n');
}

export function formatGithub(results) {
  return results.flatMap((result) => {
    if (result.sourceError) return [`::error title=driftprobe ${escapeAnnotation(result.name)}::${escapeAnnotation(result.sourceError)}`];
    return result.report.violations.map(
      (violation) => `::error title=driftprobe ${escapeAnnotation(result.name)}::${escapeAnnotation(violation.message)}`,
    );
  }).join('\n');
}

export function exitCode(results) {
  if (results.some((result) => result.report && !result.report.ok)) return 1;
  return results.some((result) => result.sourceError) ? 2 : 0;
}
