/**
 * install-shell-tracker — hardening tests for the $PROFILE installer.
 *
 * Covers Patient Zero (tracker never sourced) and the secondary failures
 * surfaced in the audit map: idempotency, uninstall round-trip, append vs
 * overwrite, missing-tracker error, marker isolation in profiles with
 * unrelated content.
 *
 * Run: node --test tests/install-shell-tracker.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  install, uninstall, check, hasMarker, buildBlock, stripMarker,
} from '../scripts/install-shell-tracker.mjs';

function tmpProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-installer-'));
  return path.join(dir, 'Microsoft.PowerShell_profile.ps1');
}

const TRACKER = path.resolve('config/vaultflow-shell-tracker.ps1');

test('install: creates profile + appends marker block when profile is missing', () => {
  const profile = tmpProfile();
  const r = install({ profilePath: profile, trackerPath: TRACKER });
  assert.equal(r.action, 'installed');
  const body = fs.readFileSync(profile, 'utf8');
  assert.ok(hasMarker(body), 'marker block missing after install');
  assert.ok(body.includes(TRACKER), 'absolute tracker path missing in profile');
});

test('install: idempotent — second run is a no-op', () => {
  const profile = tmpProfile();
  install({ profilePath: profile, trackerPath: TRACKER });
  const before = fs.readFileSync(profile, 'utf8');
  const r = install({ profilePath: profile, trackerPath: TRACKER });
  const after = fs.readFileSync(profile, 'utf8');
  assert.equal(r.action, 'noop');
  assert.equal(before, after, 'profile bytes drifted on idempotent re-install');
});

test('install: preserves unrelated profile content', () => {
  const profile = tmpProfile();
  const userContent = "function Get-Hi { 'hello' }\r\nSet-Alias hi Get-Hi\r\n";
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, userContent, 'utf8');

  install({ profilePath: profile, trackerPath: TRACKER });
  const body = fs.readFileSync(profile, 'utf8');
  assert.ok(body.startsWith(userContent), 'user content was modified');
  assert.ok(hasMarker(body), 'marker missing');
});

test('uninstall: round-trip restores byte-identical content', () => {
  const profile = tmpProfile();
  const userContent = "Set-Alias ll Get-ChildItem\r\nfunction prompt { 'PS> ' }\r\n";
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, userContent, 'utf8');

  install({ profilePath: profile, trackerPath: TRACKER });
  const r = uninstall({ profilePath: profile });
  assert.equal(r.action, 'uninstalled');
  const after = fs.readFileSync(profile, 'utf8');
  assert.equal(after, userContent, `uninstall did not restore original content. got: ${JSON.stringify(after)}`);
});

test('uninstall: noop when marker is absent', () => {
  const profile = tmpProfile();
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, 'Set-Alias g git\r\n', 'utf8');
  const r = uninstall({ profilePath: profile });
  assert.equal(r.action, 'noop');
});

test('install: throws clear error when tracker script is missing', () => {
  assert.throws(
    () => install({ profilePath: tmpProfile(), trackerPath: 'C:/does/not/exist.ps1' }),
    /tracker script not found/,
  );
});

test('check: reports installed/missing accurately', () => {
  const profile = tmpProfile();
  const before = check({ profilePath: profile });
  assert.equal(before.installed, false);
  assert.equal(before.profile_exists, false);

  install({ profilePath: profile, trackerPath: TRACKER });
  const after = check({ profilePath: profile });
  assert.equal(after.installed, true);
  assert.equal(after.profile_exists, true);
});

test('stripMarker: handles multiple installs without leaving fragments', () => {
  // Defensive: if a buggy earlier version had inserted the block twice, ensure
  // stripMarker removes all instances cleanly without leaving one orphaned.
  const block = buildBlock(TRACKER);
  const polluted = `Set-Alias g git\r\n${block}some-other-line\r\n${block}`;
  const cleaned = stripMarker(polluted);
  assert.ok(!hasMarker(cleaned), 'stripMarker left marker behind');
  assert.ok(cleaned.includes('Set-Alias g git'), 'unrelated content lost');
  assert.ok(cleaned.includes('some-other-line'), 'inter-block content lost');
});
