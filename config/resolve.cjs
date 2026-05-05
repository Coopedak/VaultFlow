'use strict';
// Returns the active config path: vaultflow.local.yaml if it exists, else vaultflow.yaml.
// All helpers require this file instead of hardcoding the config path.
const fs   = require('fs');
const path = require('path');
const local = path.join(__dirname, 'vaultflow.local.yaml');
const base  = path.join(__dirname, 'vaultflow.yaml');
module.exports = fs.existsSync(local) ? local : base;
