#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ContractError, learnContract, parseContract, serializeContract } from '../src/contract.mjs';
import { checkProfile } from '../src/check.mjs';
import { loadDocument, loadProfile, SourceError } from '../src/sources.mjs';
import { profileDocument } from '../src/profile.mjs';
import { startRecorder } from '../src/record.mjs';
import { parseJsonLines } from '../src/jsonl.mjs';
import { exitCode, formatGithub, formatHuman, neutralizeCommands } from '../src/report.mjs';
import { withoutSecretArguments, withoutSecrets } from '../src/secrets.mjs';

const DEFAULT_OBSERVED = '.driftprobe/observed.jsonl';

const USAGE = `driftprobe: data contract tests for what your AI agent really receives

  driftprobe record --upstream <url> [--port 8787] [--out ${DEFAULT_OBSERVED}]
      Proxy an API or MCP server. Point your agent at it. Stores shapes, never values.

  driftprobe learn --observed <file> --out-dir <dir>
      Write one contract per route or tool seen by the proxy.

  driftprobe learn <url-or-file> --name <name> [--items <path>] [--fields a,b] [--out <file>]
  driftprobe learn --mcp <url> --tool <name> [--args <json>] --name <name> [--fields a,b] [--out <file>]
      Learn a contract from one live response.

  driftprobe check <contract.yaml>... [--json] [--github]
      Exit code: 0 all good, 1 a contract is broken, 2 a source could not be checked.
`;

const OPTIONS = {
  upstream: { type: 'string' },
  port: { type: 'string' },
  out: { type: 'string' },
  'out-dir': { type: 'string' },
  observed: { type: 'string' },
  name: { type: 'string' },
  items: { type: 'string' },
  fields: { type: 'string' },
  mcp: { type: 'string' },
  tool: { type: 'string' },
  args: { type: 'string' },
  json: { type: 'boolean' },
  github: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

async function write(text, out) {
  if (!out) return process.stdout.write(text);
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(out, text);
  console.error(`driftprobe: wrote ${out}`);
}

async function runRecord(values) {
  if (!values.upstream) throw new ContractError('record needs --upstream');
  const out = values.out ?? DEFAULT_OBSERVED;
  const recorder = await startRecorder({ upstream: values.upstream, port: Number(values.port ?? 8787), out });
  console.error(`driftprobe: point your agent at http://127.0.0.1:${recorder.port} (forwarding to ${new URL(values.upstream).origin}, recording to ${out})`);
}

const warnAboutSecret = (variable) => console.error(`driftprobe: a credential was kept out of the contract, set ${variable} in the environment to check it`);

function storedSource(source) {
  if (!source.url) return source;
  const stored = { ...source, url: withoutSecrets(source.url, warnAboutSecret) };
  return source.arguments ? { ...stored, arguments: withoutSecretArguments(source.arguments, warnAboutSecret) } : stored;
}

function parseToolArguments(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ContractError('--args must be valid JSON');
  }
}

function sourceFromTarget(target, values) {
  if (values.mcp) {
    if (!values.tool) throw new ContractError('--mcp needs --tool');
    return { type: 'mcp', url: values.mcp, tool: values.tool, arguments: values.args ? parseToolArguments(values.args) : {} };
  }
  if (!target) throw new ContractError('learn needs a URL, a file, --mcp or --observed');
  return /^https?:\/\//.test(target) ? { type: 'http', url: target } : { type: 'file', path: target };
}

async function learnFromObserved(values) {
  if (!values['out-dir']) throw new ContractError('--observed needs --out-dir');
  const { rows, skipped } = parseJsonLines(await readFile(values.observed, 'utf8'));
  if (skipped) console.error(`driftprobe: ${skipped} corrupt line(s) skipped in ${values.observed}`);
  const groups = Map.groupBy(rows, (line) => line.key);
  // Relative and with forward slashes, so that the contract can be committed and shared.
  const path = relative(resolve(values['out-dir']), resolve(values.observed)).replaceAll('\\', '/');
  for (const [key, entries] of groups) {
    const source = { type: 'observed', path, key };
    const contract = learnContract(entries.map((entry) => entry.profile), { name: key, source });
    const file = `${key.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '')}.yaml`;
    await write(serializeContract(contract), join(values['out-dir'], file));
  }
}

async function runLearn(values, targets) {
  if (values.observed) return learnFromObserved(values);
  if (!values.name) throw new ContractError('learn needs --name');
  const source = sourceFromTarget(targets[0], values);
  const doc = await loadDocument(source);
  const profile = profileDocument(doc, { itemsPath: values.items });
  const fields = values.fields?.split(',').map((field) => field.trim());
  return write(serializeContract(learnContract([profile], { name: values.name, source: storedSource(source), fields })), values.out);
}

async function checkOne(file) {
  const contract = parseContract(await readFile(file, 'utf8'));
  try {
    const profile = await loadProfile(contract, { baseDir: dirname(resolve(file)) });
    return { name: contract.name, report: checkProfile(contract, profile) };
  } catch (error) {
    if (error instanceof SourceError) return { name: contract.name, sourceError: error.message };
    throw error;
  }
}

async function runCheck(values, files) {
  if (!files.length) throw new ContractError('check needs at least one contract file');
  const results = [];
  for (const file of files) results.push(await checkOne(file));
  if (values.github && results.some((result) => result.sourceError || !result.report.ok)) console.log(formatGithub(results));
  console.log(values.json ? JSON.stringify(results, null, 2) : formatHuman(results));
  process.exitCode = exitCode(results);
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, ...rest] = positionals;
  if (values.help || !command) return console.log(USAGE);
  const commands = { record: runRecord, learn: runLearn, check: runCheck };
  if (!commands[command]) throw new ContractError(`unknown command "${command}"\n\n${USAGE}`);
  return commands[command](values, rest);
}

main().catch((error) => {
  const expected = error instanceof ContractError || error instanceof SourceError || error.code?.startsWith?.('ERR_PARSE_ARGS') || error.code === 'ENOENT';
  console.error(`driftprobe: ${neutralizeCommands(expected ? error.message : error.stack)}`);
  process.exitCode = 2;
});
