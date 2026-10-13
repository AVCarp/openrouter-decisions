#!/usr/bin/env node
// Sets the version in openclaw.plugin.json to the given x.y.z value.
// Kept as a standalone helper so the manual release workflow (release.yml) can
// keep the manifest version in lockstep with package.json after `npm version`,
// without pulling in the catalog-sync machinery in sync-models.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const MANIFEST = path.join(ROOT, 'openclaw.plugin.json');

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`usage: node scripts/bump-manifest-version.mjs <x.y.z> (got: ${version ?? '<none>'})`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
manifest.version = version;
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`openclaw.plugin.json version -> ${version}`);
