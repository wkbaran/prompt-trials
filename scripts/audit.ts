/**
 * Fails if tracked files (and with --history, every commit) contain details that should not be
 * published: private network addresses, LAN hostnames, home paths, key-like strings, or personal
 * email addresses. Run before pushing: `npm run audit` (current files) or `npm run audit -- --history`.
 */
import { execFileSync } from 'node:child_process';

const patterns: [string, string][] = [
  ['private IPv4 address', '\\b(10\\.[0-9]{1,3}|192\\.168|172\\.(1[6-9]|2[0-9]|3[01]))\\.[0-9]{1,3}\\.[0-9]{1,3}\\b'],
  ['LAN hostname (*.home, *.local, *.lan)', '\\b[a-z0-9-]+\\.(home|lan|local|internal)\\b'],
  ['home-directory or mount path', '(/home/[a-z][a-z0-9_-]*/|/Users/[A-Za-z][A-Za-z0-9_-]*/|/mnt/[a-z]/|/var/home/|/opt/data)'],
  ['API key or token', '(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{15,}\\.[A-Za-z0-9_-]{10,})'],
  ['key/secret assigned a literal value', '(api[_-]?key|secret|token|password)[A-Za-z_]*["\']? *[:=] *["\']?[A-Za-z0-9/+_-]{16,}'],
  ['bearer token', 'Bearer +[A-Za-z0-9._-]{16,}'],
];
const emailRe = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';
const allowedEmail = /@users\.noreply\.github\.com$|^(you|user|name|email|example)@example\.(com|org)$/;

const history = process.argv.includes('--history');
const exclude = [':!package-lock.json', ':!scripts/audit.ts'];

function grep(pattern: string, revs: string[]): string[] {
  try {
    return execFileSync('git', ['grep', '-nIEo', '-e', pattern, ...revs, '--', '.', ...exclude], { encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return []; // no matches
    throw e;
  }
}

const revs = history ? execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' }).split('\n').filter(Boolean) : [];
let failures = 0;
const report = (label: string, hits: string[]) => {
  if (!hits.length) return;
  failures += hits.length;
  console.error(`\n${label}:`);
  hits.slice(0, 20).forEach((h) => console.error('  ' + h));
  if (hits.length > 20) console.error(`  ... and ${hits.length - 20} more`);
};

for (const [label, pattern] of patterns) report(label, grep(pattern, revs));
report('personal email address', grep(emailRe, revs).filter((h) => !allowedEmail.test(h.split(':').pop() ?? '')));

if (history) {
  const authors = execFileSync('git', ['log', '--all', '--format=%ae%n%ce'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  report('commit author/committer email', [...new Set(authors)].filter((a) => !allowedEmail.test(a)));
}

if (failures) {
  console.error(`\naudit failed: ${failures} finding(s). Remove them (and rewrite history if already committed) before publishing.`);
  process.exit(1);
}
console.log(`audit ok (${history ? 'files and history' : 'tracked files'})`);
