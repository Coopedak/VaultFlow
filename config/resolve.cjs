'use strict';
// Returns the active config path, checked in priority order:
//   1. vaultflow.local.yaml  — your machine-specific config (gitignored)
//   2. vaultflow.yaml        — working copy, also gitignored
//   3. vaultflow.example.yaml — shipped template (fallback, logs a warning)
//
// Setup: cp config/vaultflow.example.yaml config/vaultflow.yaml and fill in your paths.
const fs   = require('fs');
const path = require('path');

const candidates = [
  path.join(__dirname, 'vaultflow.local.yaml'),
  path.join(__dirname, 'vaultflow.yaml'),
  path.join(__dirname, 'vaultflow.example.yaml'),
];

// A config is "unfilled" if it still carries the template's placeholder paths.
// Only the example warns by filename, but a half-finished copy of it at
// priority 1 or 2 SHADOWS the example silently — every vault path then dangles
// with no diagnostic at all, which is strictly worse than running the template.
// Detect by content, not filename, so the warning follows the actual problem.
const PLACEHOLDER = /C:\/Users\/YOU\b/;

for (const p of candidates) {
  if (fs.existsSync(p)) {
    if (p.endsWith('vaultflow.example.yaml')) {
      process.stderr.write(
        '[vaultflow] WARNING: running from example config — ' +
        'run `npm run setup` to generate config/vaultflow.local.yaml for this machine\n'
      );
    } else {
      try {
        if (PLACEHOLDER.test(fs.readFileSync(p, 'utf8'))) {
          process.stderr.write(
            `[vaultflow] WARNING: ${path.basename(p)} still contains "C:/Users/YOU" placeholder ` +
            'paths — vault/skills/memory features will silently do nothing. ' +
            'Fix the paths, or delete the file and run `npm run setup` to regenerate it.\n'
          );
        }
      } catch (_) { /* unreadable config surfaces as a load error downstream */ }
    }
    module.exports = p;
    break;
  }
}

if (!module.exports) {
  throw new Error(
    '[vaultflow] No config found. ' +
    'Copy config/vaultflow.example.yaml to config/vaultflow.yaml and set paths.metrics_root'
  );
}
