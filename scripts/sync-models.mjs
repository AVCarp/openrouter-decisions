#!/usr/bin/env node
// Syncs the OpenRouter decisions-capable model catalog:
//   1. GET https://openrouter.ai/api/v1/models?output_modalities=decisions
//   2. Compare against models/decision-models.json (id, name, context_length, pricing.prompt).
//   3. If diff: rewrite the JSON snapshot, regenerate decisionModels[] in openclaw.plugin.json,
//      bump the patch version, git commit + push, tag v<version> (publish workflow publishes it).
//      If no diff: exit 0 quietly ("no changes").
// Never publishes manually — publishing is done by the publish workflow on the tag.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SNAPSHOT = path.join(ROOT, 'models/decision-models.json');
const MANIFEST = path.join(ROOT, 'openclaw.plugin.json');
const CATALOG_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';

// Static capability block attached to every decision model in the manifest
// (the OpenRouter decisions modality exposes all three question types).
const CAPABILITIES = {
  questionTypes: ['boolean', 'choice', 'score'],
  maxQuestions: 256,
  maxChoiceAlternatives: 255,
  maxScoreLevels: 10,
  confidence: 'provider-specific',
};

async function fetchCatalog() {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
  const json = await res.json();
  const models = Array.isArray(json?.data) ? json.data : [];
  return models
    // skip alias/redirect entries ("~..." ids) — they are not stable wire ids
    .filter((m) => typeof m.id === 'string' && !m.id.startsWith('~'))
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      context_length: m.context_length ?? 0,
      pricing: { prompt: String(m.pricing?.prompt ?? '0') },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const serialize = (models) => JSON.stringify(models, null, 2) + '\n';

function regenerateManifest(models) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  manifest.decisionModels = models.map((m) => ({
    provider: 'openrouter-decisions',
    id: m.id,
    name: m.name,
    capabilities: { ...CAPABILITIES },
  }));
  // version lives in package.json; patch bump so the tag creates a patch release
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  manifest.version = `${major}.${minor}.${patch + 1}`;
  return manifest;
}

function bumpPackageVersion(version) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    pkg.version = version;
    writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  } catch { /* package.json is optional for tagging */ }
}

function sh(cmd) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

const catalog = await fetchCatalog();
let existing = [];
try {
  existing = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
} catch { /* first run: no snapshot yet */ }

let manifestEntries = [];
try {
  manifestEntries = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    .decisionModels.map((m) => ({ id: m.id, name: m.name }));
} catch { /* missing or malformed */ }

const expectedEntries = catalog.map(({ id, name }) => ({ id, name }));
if (serialize(existing) === serialize(catalog)
    && JSON.stringify(manifestEntries) === JSON.stringify(expectedEntries)) {
  console.log('no changes');
  process.exit(0);
}

console.log(`catalog changed: ${existing.length} -> ${catalog.length} models, rewriting snapshot`);

// race protection: re-fetch and re-compare before committing (catalog is live)
const second = await fetchCatalog();
if (serialize(catalog) !== serialize(second)) {
  console.error('catalog changed between fetches, run again');
  process.exit(1);
}

mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
writeFileSync(SNAPSHOT, serialize(catalog));

const manifest = regenerateManifest(catalog);
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
bumpPackageVersion(manifest.version);

sh('git add models/decision-models.json openclaw.plugin.json package.json');
sh(`git commit -m "chore: refresh decision models catalog"`);
sh('git push');
sh(`git tag v${manifest.version}`);
sh('git push origin ' + `v${manifest.version}`);
console.log(`committed and tagged v${manifest.version}`);
