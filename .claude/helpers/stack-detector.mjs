/**
 * stack-detector.mjs — tech stack detection for vaultflow
 *
 * Scans a project directory for sentinel files and package.json deps,
 * then stores detected stacks in the project_stacks SQLite table.
 *
 * Used by hook-handler.cjs on session-start when
 * intelligence.stack_detect_on_session_start is true.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path              from 'node:path';
import fs                from 'node:fs';
import { glob }          from 'glob';

const require = createRequire(import.meta.url);

// ── sentinel rules ────────────────────────────────────────────────────────
// Each rule: { key, files?, glob?, pkgDeps? }
//   files   — any of these paths existing (relative to project root) → match
//   glob    — glob pattern under root → match if at least one result
//   pkgDeps — package.json dependency names → match if any present

const STACK_RULES = [
  // runtimes / frameworks
  { key: 'node',         files: ['package.json'] },
  { key: 'dotnet',       glob:  '**/*.csproj'    },
  { key: 'dotnet',       glob:  '**/*.sln'        },
  { key: 'python',       files: ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'] },
  { key: 'go',           files: ['go.mod']        },
  { key: 'rust',         files: ['Cargo.toml']    },
  { key: 'java',         files: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
  // frontend
  { key: 'react',        pkgDeps: ['react', 'react-dom'] },
  { key: 'vue',          pkgDeps: ['vue', '@vue/core'] },
  { key: 'angular',      files: ['angular.json'], pkgDeps: ['@angular/core'] },
  { key: 'nextjs',       pkgDeps: ['next'],        glob: 'next.config.*' },
  { key: 'vite',         pkgDeps: ['vite'],        glob: 'vite.config.*' },
  { key: 'webpack',      pkgDeps: ['webpack'],     glob: 'webpack.config.*' },
  { key: 'tailwind',     pkgDeps: ['tailwindcss'], glob: 'tailwind.config.*' },
  { key: 'typescript',   files: ['tsconfig.json'], pkgDeps: ['typescript'] },
  // testing
  { key: 'vitest',       pkgDeps: ['vitest'],      glob: 'vitest.config.*' },
  { key: 'jest',         pkgDeps: ['jest', '@jest/core'] },
  // .NET UI
  { key: 'wpf',          glob:  '**/*.xaml'       },
  { key: 'blazor',       glob:  '**/*.razor'      },
  // infra / ops
  { key: 'docker',       files: ['docker-compose.yml', 'docker-compose.yaml', 'Dockerfile'] },
  { key: 'github-actions', glob: '.github/workflows/*.yml' },
  // data
  { key: 'sqlite',       pkgDeps: ['better-sqlite3', 'sqlite3', 'sql.js'] },
  { key: 'duckdb',       pkgDeps: ['duckdb'] },
];

// ── helpers ───────────────────────────────────────────────────────────────

function fileExists(root, relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function anyFileExists(root, relPaths) {
  return relPaths.some(p => fileExists(root, p));
}

async function globHasMatch(root, pattern) {
  const results = await glob(pattern, { cwd: root, nodir: true, absolute: false });
  return results.length > 0;
}

function readPkgDeps(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return new Set();
  try {
    const pkg  = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    return new Set(Object.keys(deps));
  } catch (_) {
    return new Set();
  }
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Detect tech stacks for the given project directory.
 * Returns an array of { key, confidence } objects.
 *
 * @param {string} projectRoot  Absolute path to the project directory.
 * @returns {Promise<Array<{key: string, confidence: number}>>}
 */
export async function detectStacks(projectRoot) {
  if (!fs.existsSync(projectRoot)) return [];

  const pkgDeps  = readPkgDeps(projectRoot);
  const detected = new Map(); // key → confidence (use highest)

  for (const rule of STACK_RULES) {
    let matched    = false;
    let confidence = 1.0;

    if (rule.files && anyFileExists(projectRoot, rule.files)) {
      matched = true;
    }

    if (!matched && rule.glob) {
      try {
        matched = await globHasMatch(projectRoot, rule.glob);
        confidence = 0.9; // glob match is slightly less certain than exact sentinel
      } catch (_) {}
    }

    if (!matched && rule.pkgDeps) {
      matched    = rule.pkgDeps.some(d => pkgDeps.has(d));
      confidence = 0.95;
    }

    if (matched) {
      // Keep highest confidence if same key matched multiple ways
      if (!detected.has(rule.key) || confidence > detected.get(rule.key)) {
        detected.set(rule.key, confidence);
      }
    }
  }

  return Array.from(detected.entries()).map(([key, confidence]) => ({ key, confidence }));
}

/**
 * Detect stacks and persist them to the vaultflow DB.
 *
 * @param {string} projectRoot  Absolute project path.
 * @param {string} projectName  Short project name (stored as the key).
 * @returns {Promise<string[]>}  Array of detected stack keys.
 */
export async function detectAndStore(projectRoot, projectName) {
  const db = require('./db.cjs');
  db.initialize(null, null);
  const stacks = await detectStacks(projectRoot);

  for (const { key, confidence } of stacks) {
    try {
      db.upsertProjectStack(projectName, key, confidence);
    } catch (err) {
      process.stderr.write(`[stack-detector] upsertProjectStack error: ${err.message}\n`);
    }
  }

  return stacks.map(s => s.key);
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] || process.cwd();
  const name   = path.basename(target);
  console.log(`Detecting stacks in: ${target}`);

  detectStacks(target).then(stacks => {
    if (stacks.length === 0) {
      console.log('No stacks detected.');
    } else {
      stacks.forEach(s => console.log(`  ${s.key.padEnd(20)} confidence: ${s.confidence}`));
    }
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
