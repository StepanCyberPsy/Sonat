// macOS CI smoke check: runs the real system JXA/CoreGraphics bridge, no Xcode.
// This does not synthesize keyboard events or read ordinary keys.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createMacModifierRegistry } = require('../app/shortcuts.cjs');
async function main() {
  assert.equal(process.platform, 'darwin', 'Run this check on macOS');
  const flags = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript',
    path.join(__dirname, '../app/modifier-monitor.jxa'), '--probe'],
  { encoding: 'utf8', timeout: 10000 }).trim();
  assert.match(flags, /^\d+$/);
  assert.ok(Number.isSafeInteger(Number(flags)));
  const monitor = createMacModifierRegistry();
  try {
    assert.equal(await monitor.register('AltRight+ShiftRight', () => {}), true);
    assert.equal(monitor.error, '');
  } finally { monitor.destroy(); }
  console.log('macOS JXA/CoreGraphics modifier monitor: OK');
}
if (process.platform === 'darwin') {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
  console.log('macOS modifier monitor smoke check: skipped on ' + process.platform);
}
