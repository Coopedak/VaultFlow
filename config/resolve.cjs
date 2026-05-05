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

for (const p of candidates) {
  if (fs.existsSync(p)) {
    if (p.endsWith('vaultflow.example.yaml')) {
      process.stderr.write(
        '[vaultflow] WARNING: running from example config — ' +
        'copy config/vaultflow.example.yaml to config/vaultflow.yaml and set your paths\n'
      );
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
