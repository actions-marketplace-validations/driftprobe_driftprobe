// Builds the study panel once: scans the official MCP registry and keeps public servers
// that answer without credentials and expose a read only tool returning real data.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usableRemote } from './safety.mjs';
import { mapPool, runIsolated } from './isolated.mjs';
import { SCAN_TIMEOUT_MS, TIER_RANK } from './scan.mjs';

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const PAGE_SIZE = 100;
const MAX_PAGES = 2000;
const PAGE_PAUSE_MS = 150;
const HARD_TIMEOUT_MS = SCAN_TIMEOUT_MS * 7;
const CONCURRENCY = 10;
const PANEL_SIZE = 100;
const MAX_PER_DOMAIN = 3;
const MAX_SCANNED_PER_DOMAIN = 5;
const BATCH_SIZE = 500;
const MIN_SCANNED = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const orderKey = (name) => createHash('sha256').update(name).digest('hex');
// Hosts where every subdomain belongs to someone else, or where the last two labels are a public suffix.
const SHARED_SUFFIX_RE = /\.(?:workers\.dev|vercel\.app|netlify\.app|onrender\.com|railway\.app|fly\.dev|herokuapp\.com|pages\.dev|deno\.dev|github\.io|run\.app|modal\.run|azurewebsites\.net|amazonaws\.com|(?:co|com|org|net|gov|ac)\.[a-z]{2})$/i;
function domainOf(url) {
  const { hostname } = new URL(url);
  return hostname.split('.').slice(SHARED_SUFFIX_RE.test(hostname) ? -3 : -2).join('.');
}

async function crawlRegistry() {
  const servers = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(REGISTRY);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('version', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`registry answered HTTP ${response.status} on page ${page}`);
    const body = await response.json();
    servers.push(...body.servers);
    cursor = body.metadata?.nextCursor;
    if (!cursor) return servers;
    await sleep(PAGE_PAUSE_MS);
  }
  throw new Error(`registry pagination did not end after ${MAX_PAGES} pages`);
}

function candidatesFrom(registryEntries) {
  const seenUrls = new Set();
  const candidates = [];
  for (const entry of registryEntries) {
    const status = entry._meta?.['io.modelcontextprotocol.registry/official']?.status;
    if (status && status !== 'active') continue;
    const remote = usableRemote(entry.server);
    if (!remote || seenUrls.has(remote.url)) continue;
    seenUrls.add(remote.url);
    candidates.push({ name: entry.server.name, url: remote.url, transport: remote.type });
  }
  return diversify(candidates.sort((a, b) => orderKey(a.name).localeCompare(orderKey(b.name))));
}

// A few hosts publish thousands of near identical entries: scanning them all would bias
// the panel and hammer those hosts for nothing.
function diversify(candidates) {
  const perDomain = new Map();
  return candidates.filter(({ url }) => {
    const domain = domainOf(url);
    perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    return perDomain.get(domain) <= MAX_SCANNED_PER_DOMAIN;
  });
}

function choosePanel(scans) {
  const usable = scans.filter((scan) => scan.outcome === 'data').map((scan) => scan.entry);
  const ranked = [...usable].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || orderKey(a.name).localeCompare(orderKey(b.name)));
  const perDomain = new Map();
  const panel = [];
  for (const entry of ranked) {
    const domain = domainOf(entry.url);
    if ((perDomain.get(domain) ?? 0) >= MAX_PER_DOMAIN) continue;
    perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    panel.push(entry);
    if (panel.length === PANEL_SIZE) break;
  }
  return panel;
}

async function scanOne(candidate) {
  const result = await runIsolated('scan', { candidate }, HARD_TIMEOUT_MS);
  return result.isolationFailure ? { name: candidate.name, stage: 'worker', outcome: result.isolationFailure } : result;
}

const panelIsFull = (scans) => {
  const panel = choosePanel(scans);
  return panel.length === PANEL_SIZE && panel.every((entry) => entry.tier === 'list');
};

/** Scans in stable random order, by batches, until the panel is full and the sample is large enough. */
async function scanUntilFull(candidates) {
  const scans = [];
  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    scans.push(...(await mapPool(candidates.slice(start, start + BATCH_SIZE), CONCURRENCY, scanOne)));
    const eligible = scans.filter((scan) => scan.outcome === 'data').length;
    console.log(`scanned ${scans.length}/${candidates.length}, ${eligible} return data, ${choosePanel(scans).filter((entry) => entry.tier === 'list').length} usable as lists`);
    if (scans.length >= MIN_SCANNED && panelIsFull(scans)) break;
  }
  return scans;
}

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const registryEntries = await crawlRegistry();
  const candidates = candidatesFrom(registryEntries);
  console.log(`registry: ${registryEntries.length} servers, ${candidates.length} remote endpoints usable without credentials`);
  const scans = await scanUntilFull(candidates);
  const panel = choosePanel(scans);
  const summary = {
    scannedAt: new Date().toISOString(),
    registryServers: registryEntries.length,
    candidatesAfterDomainCap: candidates.length,
    scanned: scans.length,
    outcomes: tally(scans.map((scan) => scan.outcome)),
    answeredCatalogue: scans.filter((scan) => scan.toolCount !== undefined).length,
    withReadOnlyDeclared: scans.filter((scan) => scan.readOnlyDeclared > 0).length,
    panelTiers: tally(panel.map((entry) => entry.tier)),
    panelSize: panel.length,
  };
  await writeFile(join(DATA_DIR, 'scan.json'), JSON.stringify({ summary, scans: scans.map(({ entry, ...scan }) => scan) }, null, 2));
  await writeFile(join(DATA_DIR, 'panel.json'), JSON.stringify({ createdAt: summary.scannedAt, servers: panel }, null, 2));
  console.log(summary);
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
