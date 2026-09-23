// clean.js — removes junk files, checks gitignore, scans for hardcoded values, commits
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = __dirname;
process.chdir(root);

console.log('\n=== 1. Deleting accidental 0-byte files ===');
const junk = ['cd', 'git', 'main', 'node', 'notepad', 'clean.js.tmp'];
for (const f of junk) {
  const p = path.join(root, f);
  if (fs.existsSync(p) && fs.statSync(p).size === 0) {
    fs.unlinkSync(p);
    console.log('  deleted (0 bytes):', f);
  } else if (fs.existsSync(p)) {
    console.log('  skipped (not empty):', f);
  }
}

console.log('\n=== 2. Verifying .gitignore ===');
const required = ['.env', 'node_modules/', 'data/', 'debug-receipts/', 'test-fixtures.json', '*.db'];
let gi = fs.readFileSync('.gitignore', 'utf8');
const missing = required.filter((r) => !gi.includes(r));
if (missing.length) {
  gi += '\n# Auto-added\n' + missing.join('\n') + '\n';
  fs.writeFileSync('.gitignore', gi, 'utf8');
  console.log('  added to .gitignore:', missing.join(', '));
} else {
  console.log('  all required entries present');
}

console.log('\n=== 3. Scanning src/ for hardcoded sensitive values ===');
const patterns = [
  { name: 'CBE reference (FT...)', re: /FT[A-Z0-9]{10}/g },
  { name: 'Telebirr reference (10 chars)', re: /DIN[A-Z0-9]{7}/g },
  { name: 'Mobile receipt ID', re: /hfHCxHaJXg7XVz9GQAvs/g },
  { name: 'Ethiopian phone (2519)', re: /2519\d{8}/g },
  { name: 'Real names', re: /\b(Dagim|Abdulmejid|bertukan)\b/gi },
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let totalFindings = 0;
for (const file of walk('src')) {
  const content = fs.readFileSync(file, 'utf8');
  for (const { name, re } of patterns) {
    const matches = content.match(re);
    if (matches) {
      const uniq = [...new Set(matches)];
      console.log('  ' + file + ' -> ' + name + ': ' + uniq.join(', '));
      totalFindings += uniq.length;
    }
  }
}
if (totalFindings === 0) console.log('  no hardcoded values found in src/');
else console.log('  total findings: ' + totalFindings + ' (review them if they are real data)');

console.log('\n=== 4. Scanning public/ for hardcoded sensitive values ===');
for (const file of walk('public')) {
  const content = fs.readFileSync(file, 'utf8');
  for (const { name, re } of patterns) {
    const matches = content.match(re);
    if (matches) {
      const uniq = [...new Set(matches)];
      console.log('  ' + file + ' -> ' + name + ': ' + uniq.join(', '));
      totalFindings += uniq.length;
    }
  }
}
if (totalFindings === 0) console.log('  no hardcoded values found');

console.log('\n=== 5. Removing debug-receipts contents (real receipt HTML) ===');
if (fs.existsSync('debug-receipts')) {
  const files = fs.readdirSync('debug-receipts');
  for (const f of files) fs.unlinkSync(path.join('debug-receipts', f));
  console.log('  cleared', files.length, 'files from debug-receipts/');
}

console.log('\n=== 6. Untracking files that should be gitignored ===');
for (const f of ['test-fixtures.json', 'debug-receipts', 'data', '.env']) {
  try {
    execSync(`git rm --cached -r "${f}"`, { stdio: 'ignore' });
    console.log('  untracked:', f);
  } catch {}
}

console.log('\n=== 7. Showing git status ===');
try { execSync('git status --short', { stdio: 'inherit' }); } catch {}

console.log('\n=== 8. Committing ===');
try {
  execSync('git add -A', { stdio: 'inherit' });
  execSync('git commit -m "Remove accidental files, ensure gitignore protects sensitive data"', { stdio: 'inherit' });
  console.log('\n=== 9. Pushing ===');
  execSync('git push', { stdio: 'inherit' });
  console.log('\nDONE');
} catch (e) {
  console.log('\nGit error:', e.message);
  console.log('(If nothing to commit, that is fine.)');
}