// #33 (owner decision 3a): the Release workflow checks the version and that CI
// passed on the commit, writes the release notes from the PRs merged since the
// last release, and makes a draft release the owner publishes. Before, a
// release was tagged by hand with no notes. Run: node --test scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_CHECKS, ciVerdict, parseCommits, releaseNotes, versionProblem } from './release.mjs';

test('the version is the one in package.json, as x.y.z or a pre-release x.y.z-label.n', () => {
  assert.equal(versionProblem('2.0.0', '2.0.0'), null);
  assert.equal(versionProblem('2.0.0-rc.1', '2.0.0-rc.1'), null);
  assert.match(versionProblem('2.0.1', '2.0.0'), /package\.json says 2\.0\.0/);
  assert.match(versionProblem('v2.0.0', '2.0.0'), /without the v/);
  assert.match(versionProblem('2.0', '2.0'), /not a version/);
});

test('CI must have passed on the commit: every required check, its latest run successful', () => {
  const run = (name, conclusion, completed_at = '2026-11-11T10:00:00Z') => ({ name, status: 'completed', conclusion, completed_at });
  const green = REQUIRED_CHECKS.map((n) => run(n, 'success'));
  assert.deepEqual(ciVerdict(green), { ok: true, problems: [] });

  const missing = ciVerdict(green.filter((r) => !r.name.startsWith('E2E')));
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0], /E2E journeys .* has not run/);

  const red = ciVerdict([...green.filter((r) => !r.name.startsWith('API')), run('API tests (PostgreSQL 18)', 'failure')]);
  assert.match(red.problems[0], /API tests .* failure/);

  // A re-run that passed counts: the latest run of each check decides.
  const rerun = ciVerdict([...green, run('API tests (PostgreSQL 18)', 'failure', '2026-11-11T09:00:00Z')]);
  assert.equal(rerun.ok, true);

  const pending = ciVerdict([...green.filter((r) => !r.name.startsWith('Web')), { name: 'Web tests and build', status: 'in_progress', conclusion: null, completed_at: null }]);
  assert.match(pending.problems[0], /Web tests and build: still running/);
});

test('the notes list the PRs merged since the last release, newest first, without sync merges', () => {
  const log = [
    'a1\tStructured logging, log rotation, liveness and readiness (#32) (#260)',
    'b2\tSync with main after #259',
    'c3\tImport from a v1 shop (#246, part 5) (#259)',
    'd4\tMerge branch release/1.x into main',
    'e5\tFix a typo in the guide',
  ].join('\n');
  const commits = parseCommits(log);
  assert.deepEqual(commits.map((c) => c.pr), [260, 259, null]);

  const notes = releaseNotes({ version: '2.0.0', date: '2026-11-11', previousTag: 'v1.1.1', commits, repo: 'King2H/Standard-Bookstore-ERP' });
  assert.equal(notes, [
    '## Bookstore 2.0.0 (2026-11-11)',
    '',
    'Changes since v1.1.1:',
    '',
    '- Structured logging, log rotation, liveness and readiness (#32) ([#260](https://github.com/King2H/Standard-Bookstore-ERP/pull/260))',
    '- Import from a v1 shop (#246, part 5) ([#259](https://github.com/King2H/Standard-Bookstore-ERP/pull/259))',
    '- Fix a typo in the guide',
    '',
    'To install or upgrade, download `bookstore-2.0.0.zip` (check it against `SHA256SUMS`) and follow `docs/install.md` in it.',
    '',
  ].join('\n'));
});

test('a first release lists every change', () => {
  const notes = releaseNotes({ version: '2.0.0', date: '2026-11-11', previousTag: null, commits: parseCommits('a1\tFirst (#1)'), repo: 'o/r' });
  assert.match(notes, /^## Bookstore 2\.0\.0 \(2026-11-11\)\n\nChanges:\n\n- First \(\[#1\]/);
});
