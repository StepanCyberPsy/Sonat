// Run on macOS against both the built bundle and the extracted distribution.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const bundle = process.argv[2];
if (process.platform !== 'darwin' || !bundle) throw Error('Pass a macOS Sonat.app bundle');
const helper = path.join(bundle, 'Contents/Helpers/SonatCallProbe');
const output = execFileSync(helper, ['--once'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
const result = JSON.parse(output.trim());
assert.equal(result.schemaVersion, 1);
assert.ok(['ok', 'partial', 'error'].includes(result.status));
assert.ok(Array.isArray(result.processes) && Array.isArray(result.meetings));
const self = JSON.parse(execFileSync(helper, ['--self-test'], { encoding: 'utf8', timeout: 10000 }));
assert.equal(self.status, 'ok');
assert.ok(self.checks.meetingPatterns && self.checks.nestedApp);
// Exercise the same persistent, newline-delimited bridge used by the application.
const { createInterface } = require('node:readline');
const child = spawn(helper, ['--watch'], { stdio: ['ignore', 'pipe', 'inherit'] });
let received = 0;
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 16000);
createInterface({input: child.stdout}).on('line', line => {
  const sample = JSON.parse(line);
  assert.ok(['ok','partial','error'].includes(sample.status) && Array.isArray(sample.processes));
  if (++received === 2) child.kill();
});
child.on('close', () => {
  clearTimeout(timer);
  assert.ok(received >= 2, 'continuous CoreAudio snapshots');
  console.log('PASS: packaged SonatCallProbe snapshots, window patterns and continuous monitoring');
});
