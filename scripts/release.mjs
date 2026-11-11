// The Release workflow's rules (#33, owner decision 3a), with no dependencies:
//   node scripts/release.mjs version <version>          the version is package.json's
//   node scripts/release.mjs ci <check-runs.json>       CI passed on the commit
//   node scripts/release.mjs notes <version> <repo> [previous tag]   the notes, from git
// The workflow makes a draft release; the owner reviews and publishes it,
// and GitHub tags the commit then.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The CI checks a release needs (.github/workflows/ci.yml). */
export const REQUIRED_CHECKS = [
  'Lint, typecheck, audit',
  'Web tests and build',
  'API tests (PostgreSQL 18)',
  'E2E journeys (production images)',
];

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** Why the version cannot be released, or null. */
export function versionProblem(version, packageVersion) {
  if (/^v\d/.test(version)) return `Give the version without the v: ${version.slice(1)}`;
  if (!SEMVER.test(version)) return `${version} is not a version: x.y.z, or x.y.z-rc.1 for a pre-release`;
  if (version !== packageVersion) return `package.json says ${packageVersion}: change it there first (one version source, #245), then release`;
  return null;
}

/** Whether CI passed on the commit: the latest run of every required check succeeded. */
export function ciVerdict(checkRuns, required = REQUIRED_CHECKS) {
  const problems = [];
  for (const name of required) {
    const runs = checkRuns.filter((r) => r.name === name);
    if (runs.length === 0) { problems.push(`${name}: has not run on this commit`); continue; }
    const latest = runs.reduce((a, b) => ((a.completed_at ?? '9') >= (b.completed_at ?? '9') ? a : b));
    if (latest.status !== 'completed') problems.push(`${name}: still running`);
    else if (latest.conclusion !== 'success') problems.push(`${name}: ${latest.conclusion}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The changes on main, from `git log --first-parent --format=%H%x09%s`:
 * each PR is one squashed commit ending "(#N)". Sync and merge commits are
 * not changes of their own.
 */
export function parseCommits(log) {
  return log.split('\n').filter((l) => l.trim()).map((line) => {
    const [sha, ...rest] = line.split('\t');
    const subject = rest.join('\t').trim();
    const pr = /\(#(\d+)\)$/.exec(subject);
    return { sha, subject: pr ? subject.slice(0, pr.index).trim() : subject, pr: pr ? Number(pr[1]) : null };
  }).filter((c) => !/^(Sync with main|Merge )/.test(c.subject));
}

export function releaseNotes({ version, date, previousTag, commits, repo }) {
  const lines = commits.map((c) => (c.pr ? `- ${c.subject} ([#${c.pr}](https://github.com/${repo}/pull/${c.pr}))` : `- ${c.subject}`));
  return [
    `## Bookstore ${version} (${date})`,
    '',
    previousTag ? `Changes since ${previousTag}:` : 'Changes:',
    '',
    ...lines,
    '',
    `To install or upgrade, download \`bookstore-${version}.zip\` (check it against \`SHA256SUMS\`) and follow \`docs/install.md\` in it.`,
    '',
  ].join('\n');
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (command === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const problem = versionProblem(args[0] ?? '', pkg.version);
    if (problem) fail(problem);
    console.log(`Version ${args[0]}: as in package.json.`);
  } else if (command === 'ci') {
    const verdict = ciVerdict(JSON.parse(readFileSync(args[0], 'utf8')));
    if (!verdict.ok) fail(`CI has not passed on this commit:\n- ${verdict.problems.join('\n- ')}`);
    console.log('CI passed on this commit.');
  } else if (command === 'notes') {
    const [version, repo, previousTag] = args;
    if (!version || !repo) fail('Usage: node scripts/release.mjs notes <version> <owner/repo> [previous tag]');
    const range = previousTag ? [`${previousTag}..HEAD`] : ['HEAD'];
    const log = execFileSync('git', ['log', '--first-parent', '--format=%H%x09%s', ...range], { cwd: root, encoding: 'utf8' });
    process.stdout.write(releaseNotes({
      version, repo, previousTag: previousTag || null, commits: parseCommits(log), date: new Date().toISOString().slice(0, 10),
    }));
  } else {
    fail('Usage: node scripts/release.mjs version <version> | ci <check-runs.json> | notes <version> <owner/repo> [previous tag]');
  }
}
