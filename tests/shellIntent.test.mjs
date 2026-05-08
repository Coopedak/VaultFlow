/**
 * shell-intent — read-intent extraction from Bash command strings.
 * Run: node --test tests/shellIntent.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractReadIntents, tokenize } = require('../.claude/helpers/shell-intent.cjs');

test('cat single file', () => {
  assert.deepEqual(extractReadIntents('cat README.md'), ['README.md']);
});

test('head/tail with flags', () => {
  assert.deepEqual(extractReadIntents('head -n 50 src/index.ts'), ['src/index.ts']);
  assert.deepEqual(extractReadIntents('tail -f /var/log/app.log'), ['/var/log/app.log']);
});

test('multiple files via cat', () => {
  assert.deepEqual(
    extractReadIntents('cat a.md b.md c.md'),
    ['a.md', 'b.md', 'c.md']
  );
});

test('quoted path with spaces', () => {
  assert.deepEqual(
    extractReadIntents('cat "C:/Users/YOU/notes file.md"'),
    ['C:/Users/YOU/notes file.md']
  );
});

test('chained statements via && and ;', () => {
  assert.deepEqual(
    extractReadIntents('cd src && cat foo.ts ; tail -n 20 bar.ts'),
    ['foo.ts', 'bar.ts']
  );
});

test('piped statements: only the read-cmd side counts', () => {
  // `cat foo | grep bar` — grep is not a read-intent command for our purposes.
  assert.deepEqual(extractReadIntents('cat foo.txt | grep zebra'), ['foo.txt']);
});

test('not a read command: ignored', () => {
  assert.deepEqual(extractReadIntents('grep -r foo src/'), []);
  assert.deepEqual(extractReadIntents('echo hello'), []);
  assert.deepEqual(extractReadIntents('npm install'), []);
});

test('env-var preamble is skipped', () => {
  assert.deepEqual(
    extractReadIntents('FOO=bar BAZ=qux cat config/app.yaml'),
    ['config/app.yaml']
  );
});

test('flag-shaped tokens are rejected', () => {
  // -n is a flag, not a path
  assert.deepEqual(extractReadIntents('cat -n -E foo.txt'), ['foo.txt']);
});

test('path heuristic rejects bare words', () => {
  // 'banana' has no slash and no extension — not treated as a path.
  assert.deepEqual(extractReadIntents('cat banana'), []);
  // ./foo passes (slash present)
  assert.deepEqual(extractReadIntents('cat ./foo'), ['./foo']);
  // foo.md passes (extension present)
  assert.deepEqual(extractReadIntents('cat foo.md'), ['foo.md']);
});

test('cap at 10 paths', () => {
  const args = Array.from({ length: 15 }, (_, i) => `f${i}.md`).join(' ');
  const out = extractReadIntents(`cat ${args}`);
  assert.equal(out.length, 10);
});

test('dedupe within one command', () => {
  assert.deepEqual(extractReadIntents('cat foo.md foo.md bar.md'), ['foo.md', 'bar.md']);
});

test('Windows paths', () => {
  assert.deepEqual(
    extractReadIntents('cat "C:\\GIT\\vaultflow\\README.md"'),
    ['C:\\GIT\\vaultflow\\README.md']
  );
});

test('empty / non-string returns []', () => {
  assert.deepEqual(extractReadIntents(''), []);
  assert.deepEqual(extractReadIntents(null), []);
  assert.deepEqual(extractReadIntents(undefined), []);
});

test('tokenize: quoted strings, escapes, multiple tokens', () => {
  assert.deepEqual(tokenize('cat "a b" \'c d\' e'), ['cat', 'a b', 'c d', 'e']);
  assert.deepEqual(tokenize('cat foo\\ bar'), ['cat', 'foo bar']);
});
