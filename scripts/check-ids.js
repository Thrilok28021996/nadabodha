#!/usr/bin/env node
/**
 * ID contract check: every element id referenced by src/renderer/renderer.ts
 * or scripts/cdp-smoke.mjs must still exist in src/renderer/index.html after
 * the two-column restructure (approved plan, workstream 1 hard constraint).
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

const sources = ['src/renderer/renderer.ts', 'scripts/cdp-smoke.mjs'];
const used = new Map();

for (const rel of sources) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const m of text.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(rel);
  }
  // querySelector('#id ...') / querySelector("#id")
  for (const m of text.matchAll(/querySelector\(\s*['"]#([A-Za-z][\w-]*)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(rel);
  }
  // querySelectorAll('#id ...') and template-string selectors
  for (const m of text.matchAll(/querySelectorAll\(\s*[`'"]#([A-Za-z][\w-]*)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(rel);
  }
  for (const m of text.matchAll(/querySelector\(\s*`[^`]*#([A-Za-z][\w-]*)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(rel);
  }
}

const missing = [...used.keys()].filter((id) => !declared.has(id)).sort();
const usedIds = [...used.keys()].sort();

console.log(`ids referenced: ${usedIds.length}`);
console.log(`ids declared in index.html: ${declared.size}`);
if (missing.length) {
  console.error(`MISSING IDS (${missing.length}):`);
  for (const id of missing) console.error(`  ${id}  <- ${[...used.get(id)].join(', ')}`);
  process.exit(1);
}
console.log('OK: every referenced id exists in index.html');

// Also report ids declared but unused (informational only).
const unused = [...declared].filter((id) => !used.has(id)).sort();
if (unused.length) console.log(`declared but not referenced by those two files: ${unused.join(', ')}`);
