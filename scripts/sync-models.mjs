#!/usr/bin/env node
// Syncs the OpenRouter decisions-capable model catalog:
//   1. GET https://openrouter.ai/api/v1/models?output_modalities=decisions
//   2. Compare against models/decision-models.json (id, name, context_length, pricing.prompt).
//   3. Outcomes:
//      - before any tier: a prepared-but-unpushed release (local tag at HEAD, absent on
//        origin) is always re-pushed first, independent of the outcomes below;
//      - identical snapshot and manifest entries: exit 0 quietly ("no changes");
//      - only context_length/pricing.prompt moved: rewrite the snapshot and push a plain
//        commit — no manifest regeneration, no version bump, no tag, no release;
//      - id/name set or manifest entries changed: full release — rewrite the snapshot,
//        regenerate decisionModels[] in openclaw.plugin.json, bump the patch version,
//        commit + tag v<version>, push branch + tag in one push (the publish workflow
//        publishes the tag). Never publishes manually.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
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
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(120000) });
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

// strict package.json version validation; returns the validated version string
function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`unsupported package.json version: ${pkg.version} — expected x.y.z`);
  }
  return pkg.version;
}

// next patch version derived from the validated package.json version
function nextVersion() {
  const [major, minor, patch] = readPackageVersion().split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function regenerateManifest(models, version) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  manifest.decisionModels = models.map((m) => ({
    provider: 'openrouter-decisions',
    id: m.id,
    name: m.name,
    capabilities: { ...CAPABILITIES },
  }));
  // version lives in package.json; patch bump so the tag creates a patch release
  manifest.version = version;
  return manifest;
}

function bumpPackageVersion(version) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.version = version;
  writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

function sh(cmd) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', timeout: 120000 });
}

// non-empty ls-remote output means the tag exists on the remote
function remoteTagExists(tag) {
  const out = execSync(`git ls-remote --tags origin refs/tags/${tag}`, { cwd: ROOT, encoding: 'utf8', timeout: 120000 }).trim();
  return out !== '';
}

function pushBranchAndTag(tag) {
  sh(`git push --atomic origin HEAD ${tag}`);
}

// Marks a successfully pushed release for the publish workflow. The tag travels as
// a step output via GITHUB_OUTPUT in CI (read as steps.sync.outputs.release-tag) or
// a log line in local runs; no file-based marker contract remains.
function markPushedRelease(tag) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `release-tag=${tag}\n`);
  else console.log(`pushed release: ${tag}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Detached-HEAD + remote-divergence guards; shared by the commit paths and recovery.
function assertBranchInSync() {
  // refuse to build or push a release from a detached HEAD
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!branch || branch === 'HEAD') {
    console.error('aborting: detached HEAD — checkout a branch before running');
    process.exit(1);
  }

  // fetch first so the divergence check sees the real remote state
  sh('git fetch origin');
  const remoteRef = `origin/${branch}`;
  const remoteExists = execSync(`git rev-parse --verify --quiet ${remoteRef} || true`, { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
  if (remoteExists) {
    const raw = execSync(`git rev-list --count HEAD..${remoteRef}`, { cwd: ROOT, encoding: 'utf8' }).trim();
    const behind = Number(raw);
    if (!Number.isInteger(behind)) {
      console.error(`aborting: cannot parse divergence from ${remoteRef}: ${raw}`);
      process.exit(1);
    }
    if (behind > 0) {
      console.error(`aborting: ${branch} is behind ${remoteRef} by ${behind} commit(s) —`);
      console.error(`reconcile with the remote (git pull --rebase) and rerun the sync`);
      process.exit(1);
    }
  }
}

// Recovery after a failed release push: files already match the catalog (no changes),
// but a previous run may have prepared a release — commit + local tag — and never
// pushed it. The prepared tag is v<package.json version> (the release path bumps
// package.json before tagging); when origin lacks it, re-attempt the same combined
// push instead of exiting quietly. This also covers a release whose commit was
// rewritten by the `git pull --rebase` this script advises on divergence: the tag
// then points at the pre-rebase SHA, so recovery force-moves it to HEAD (the rebase
// preserved the release content) and recovers the prepared release at the rebased tip.
function recoverUnpushedRelease() {
  let version;
  try {
    version = readPackageVersion();
  } catch {
    return; // no package.json: nothing to recover
  }
  const tag = `v${version}`;
  const tagCommit = execSync(`git rev-parse --verify --quiet refs/tags/${tag}^{commit} || true`, { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!tagCommit) return;
  if (remoteTagExists(tag)) return; // release already pushed: quiet post-release rerun
  const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (tagCommit !== head) {
    // The script's own divergence abort advises `git pull --rebase`, which rewrites
    // the release commit and leaves the prepared tag pointing at the pre-rebase SHA.
    // A rebase that preserves the release content keeps the tree identical, so tree
    // equality is the provenance check: only then is force-moving the LOCAL tag to
    // HEAD safe. Any other divergence — commits added after the failed push, a hand
    // edit between runs, or an unrelated local tag colliding with v<pkgver> — aborts
    // instead of force-publishing content that was never part of the prepared release.
    const taggedTree = execSync(`git rev-parse ${tag}^{tree}`, { cwd: ROOT, encoding: 'utf8' }).trim();
    const headTree = execSync('git rev-parse HEAD^{tree}', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (taggedTree !== headTree) {
      console.error(`aborting: ${tag} points at ${tagCommit} whose tree differs from HEAD — reconcile manually (inspect: git show ${tag})`);
      process.exit(1);
    }
    console.log(`prepared release tag ${tag} is on the pre-rebase commit — moving it to HEAD and publishing`);
    execSync(`git tag -f ${tag} HEAD`, { cwd: ROOT, stdio: 'inherit' });
  }
  // prepared release available: run the detached/divergence guards, but skip the
  // tag-collision abort — this tag is the prepared release, not a collision. The
  // guards run after the re-tag, so a still-divergent (behind) branch aborts here
  // and nothing is published from the stale branch.
  assertBranchInSync();
  console.log(`unpushed release detected: pushing ${tag} again`);
  pushBranchAndTag(tag);
  markPushedRelease(tag);
  process.exit(0);
}

// Deploy-safety: a tag pushed with the default GITHUB_TOKEN does not trigger the
// publish workflow by itself; the sync job dispatches it explicitly (or the
// recovery path above does). If that dispatch failed on a previous run while the
// tag push succeeded, the release is stranded on origin with no publish run
// while every later run turns green on "no changes". Detect the stranded state:
// re-dispatch in CI, abort with the manual command in local runs.
async function ensurePublishedRelease() {
  let version;
  try {
    version = readPackageVersion();
  } catch {
    return; // no package.json: nothing to check
  }
  const tag = `v${version}`;
  if (!remoteTagExists(tag)) return; // not on origin: normal paths handle it
  let published;
  try {
    published = execSync(
      `gh run list --workflow=package-publish.yml --branch ${tag} --status success --limit 1`,
      { cwd: ROOT, encoding: 'utf8', timeout: 120000, stdio: ['ignore'] },
    ).trim() !== '';
  } catch {
    console.log(`warning: cannot verify a package-publish run for ${tag} (gh unavailable or unauthenticated)`);
    return;
  }
  if (published) return;
  if (!process.env.GITHUB_ACTIONS) {
    console.error(`aborting: pushed tag ${tag} has no successful package-publish run — publish manually with: gh workflow run package-publish.yml --ref ${tag}`);
    process.exit(1);
  }
  console.log(`pushed tag ${tag} has no successful package-publish run — re-dispatching`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      sh(`gh workflow run package-publish.yml --ref ${tag}`);
      console.log(`re-dispatched package-publish for ${tag}`);
      process.exit(0);
    } catch {
      if (attempt === 3) break;
      await sleep(5000);
    }
  }
  console.error(`failed to dispatch package-publish for ${tag} after 3 attempts — rerun manually with: gh workflow run package-publish.yml --ref ${tag}`);
  process.exit(1);
}

const catalog = await fetchCatalog();
if (catalog.length === 0) {
  console.error('aborting: catalog fetch returned 0 models — upstream anomaly or outage, not a catalog change');
  process.exit(1);
}
let existing = [];
try {
  const parsed = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  // non-array snapshots fall back to [] and self-heal via the normal rewrite below
  if (Array.isArray(parsed)) existing = parsed;
} catch { /* first run: no snapshot yet */ }

let manifestEntries = [];
try {
  manifestEntries = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    .decisionModels.map((m) => ({ id: m.id, name: m.name }));
} catch { /* missing or malformed */ }

const expectedEntries = catalog.map(({ id, name }) => ({ id, name }));
const snapshotSame = serialize(existing) === serialize(catalog);
const manifestSame = JSON.stringify(manifestEntries) === JSON.stringify(expectedEntries);
// a prepared-but-unpushed release is recovered regardless of the catalog tier: a
// failed release push must be re-attempted even when the catalog changed meanwhile,
// otherwise the next commit would push the branch without the prepared tag
recoverUnpushedRelease();
// a tag whose publish dispatch failed on a previous run is stranded on origin with
// no local trace in CI; detect it before the "no changes" early exit hides it
await ensurePublishedRelease();
if (snapshotSame && manifestSame) {
  console.log('no changes');
  process.exit(0);
}

// snapshot-only tier: id/name set and manifest entries unchanged, only volatile fields
// (context_length, pricing.prompt) moved — refresh the snapshot without a release
const identitySame = JSON.stringify(existing.map(({ id, name }) => ({ id, name })))
  === JSON.stringify(expectedEntries);
const snapshotOnly = identitySame && manifestSame;

console.log(snapshotOnly
  ? 'catalog pricing/context updated, refreshing snapshot (no release)'
  : `catalog changed: ${existing.length} -> ${catalog.length} models, rewriting snapshot`);

// race protection: re-fetch and re-compare before committing (catalog is live)
const second = await fetchCatalog();
if (serialize(catalog) !== serialize(second)) {
  console.error('catalog changed between fetches, run again');
  process.exit(1);
}

// strict package.json version validation (before any writes); the next patch version
// is the prospective release tag checked by the tag guard below
const version = nextVersion();

// regenerateManifest is only needed for a full release — call before any file writes
const manifest = snapshotOnly ? null : regenerateManifest(catalog, version);

// --- guards: all checks run before any writes, add, or commit (both commit paths) ---

// detached HEAD + remote divergence (shared with the unpushed-release recovery path)
assertBranchInSync();

// abort before committing if the prospective release tag already exists (e.g. a
// previous committed-but-never-published run), so the branch is never pushed with
// an untagged version bump; only the full-release path below creates tags, so the
// snapshot-only path skips this guard entirely
const tag = `v${version}`;
if (!snapshotOnly) {
  const localTag = execSync(`git tag --list ${tag}`, { cwd: ROOT, encoding: 'utf8' }).trim();
  const remoteTag = remoteTagExists(tag);
  if (localTag || remoteTag) {
    const where = localTag && remoteTag ? ' locally and on origin' : localTag ? ' locally' : ' on origin';
    console.error(`aborting: tag ${tag} already exists${where} — bump package.json past it and rerun`);
    process.exit(1);
  }
}

mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
writeFileSync(SNAPSHOT, serialize(catalog));

if (snapshotOnly) {
  // pricing/context-only refresh: no manifest regeneration, no version bump, no tag, no release
  sh('git add models/decision-models.json');
  sh(`git commit -m "chore: refresh decision models catalog (pricing/context only, no release)"`);
  sh('git push origin HEAD');
  console.log('catalog pricing/context updated, snapshot committed (no release)');
} else {
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  bumpPackageVersion(manifest.version);

  // commit and tag locally, then publish branch + tag in one push so nothing is partially published
  sh('git add models/decision-models.json openclaw.plugin.json package.json');
  sh(`git commit -m "chore: refresh decision models catalog"`);
  sh(`git tag ${tag}`);
  pushBranchAndTag(tag);
  markPushedRelease(tag);
  console.log(`committed and tagged v${manifest.version}`);
}
