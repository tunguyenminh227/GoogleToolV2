const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResult } = require('./native-results.cjs');

test('native report requires matching visible and detail scores, not a stray number', () => {
  const page = 'Your Digital Identity Looks\nReliable\n100\nMX Score\nSIGNALS\nMX Score\n100\nhasCDP\nfalse\nhasWebdriver\nfalse\nhasUserAgent\nfalse\nhasNavigator\nfalse';
  assert.equal(parseResult(page.replace(/\n/g, '\r\n')).score, 100);
  assert.equal(parseResult(page).flags.hasCDP, false);
  assert.equal(parseResult('Advertisement: 100\nMX Score').score, null);
  assert.equal(parseResult(page.replace('MX Score\n100', 'MX Score\n90')).score, null);
  assert.equal(parseResult('').flags.hasCDP, null);
  assert.deepEqual(parseResult(page + '\nDetected an inconsistent browser fingerprint (eagle)').signals,
    ['Detected an inconsistent browser fingerprint (eagle)']);
});
