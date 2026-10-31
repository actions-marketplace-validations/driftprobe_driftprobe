// Scans one candidate for the panel. Runs inside a worker, like observations.
import { classifyError, listAllTools, payloadFromToolResult, withMcpClient } from '../src/mcp.mjs';
import { profileDocument } from '../src/profile.mjs';
import { buildArguments, isPublicHttpsUrl, isSafeTool } from './safety.mjs';
import { connectionOptions } from './observe.mjs';

export const SCAN_TIMEOUT_MS = 15_000;
const MAX_TOOLS_TRIED = 3;
const MIN_LIST_ITEMS = 3;

export const TIER_RANK = { list: 0, record: 1, text: 2 };

function dataTier(format, profile) {
  const fieldCount = Object.keys(profile.fields).length;
  if (format === 'json' && profile.itemCount >= MIN_LIST_ITEMS && fieldCount >= 2) return 'list';
  if (format === 'json' && profile.itemCount >= 1 && fieldCount >= 1) return 'record';
  return format === 'text' && profile.itemCount >= 1 ? 'text' : null;
}

async function tryTool(client, tool, args) {
  const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: SCAN_TIMEOUT_MS });
  if (result.isError) return null;
  const { format, doc } = payloadFromToolResult(result);
  const profile = profileDocument(doc);
  const tier = dataTier(format, profile);
  if (!tier) return null;
  return { tier, tool: tool.name, args, format, itemsPath: format === 'json' ? profile.itemsPath : undefined, itemCount: profile.itemCount, fieldCount: Object.keys(profile.fields).length };
}

async function bestTool(client, safeTools, scan) {
  let best = null;
  for (const { tool, args } of safeTools.slice(0, MAX_TOOLS_TRIED)) {
    let found;
    try {
      found = await tryTool(client, tool, args);
    } catch (error) {
      scan.toolCallFailure = classifyError(error);
      continue;
    }
    if (found && (!best || TIER_RANK[found.tier] < TIER_RANK[best.tier])) best = found;
    if (best?.tier === 'list') break;
  }
  return best;
}

export async function scanCandidate(candidate) {
  const scan = { name: candidate.name, stage: 'guard' };
  if (!(await isPublicHttpsUrl(candidate.url))) return { ...scan, outcome: 'not_public' };
  scan.stage = 'connect';
  try {
    return await withMcpClient(connectionOptions(candidate, SCAN_TIMEOUT_MS), async (client) => {
      scan.stage = 'list';
      const tools = await listAllTools(client, SCAN_TIMEOUT_MS);
      scan.toolCount = tools.length;
      scan.readOnlyDeclared = tools.filter((tool) => tool.annotations?.readOnlyHint === true).length;
      const safeTools = tools.filter(isSafeTool).map((tool) => ({ tool, args: buildArguments(tool) })).filter(({ args }) => args);
      scan.callable = safeTools.length;
      if (!safeTools.length) return { ...scan, outcome: 'no_safe_tool' };
      scan.stage = 'call';
      const best = await bestTool(client, safeTools, scan);
      return best ? { ...scan, outcome: 'data', entry: { ...candidate, ...best } } : { ...scan, outcome: 'no_data' };
    });
  } catch (error) {
    return { ...scan, outcome: classifyError(error) };
  }
}
