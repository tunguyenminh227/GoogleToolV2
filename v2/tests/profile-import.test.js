const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, importLines } = require('../profile-import');
const { traced: t } = require('../trace-log');

test('bare email followed by labeled credentials stays one profile', t('test.bareEmailBlocks', () => {
  const text = 'first@example.com\nPassword: fixture-pass\nRecovery: recovery@example.com\n2FA key:\nsecond@example.com\nPassword: second-pass\nRecovery:\n2FA key: JBSWY3DP';
  const blocks = importLines(text);
  assert.equal(blocks.length, 2);
  assert.equal(parseLine(blocks[0].line).password, 'fixture-pass');
  assert.equal(parseLine(blocks[1].line).twofa, 'JBSWY3DP');
  assert.deepEqual(blocks.map(t('test.blockRanges', block => [block.lineNumber, block.endLineNumber])), [[1, 4], [5, 8]]);
  assert.throws(() => importLines('Password: orphan\nRecovery: recovery@example.com'), /bắt đầu/);
}));

test('label blocks accept escaped formatting, blank 2FA and retain whole failed blocks', t('test.importBlocks', () => {
  const text = String.raw`Email: first\@example.com
Password: pass\@word\
Recovery: recovery\@example.com\
2FA key: jbswy3dp\
Email: second@example.com
Password: second-pass
Recovery:
2FA key:
Email: third@example.com
2FA key: invalid0key`;
  const blocks = importLines(text);
  assert.equal(blocks.length, 3);
  assert.deepEqual(parseLine(blocks[0].line), { email: 'first@example.com', password: 'pass@word', recoveryMail: 'recovery@example.com', twofa: 'JBSWY3DP' });
  assert.equal(parseLine(blocks[1].line).twofa, '');
  assert.equal(blocks[1].lineNumber, 5);
  assert.equal(blocks[1].endLineNumber, 8);
  assert.throws(() => parseLine(blocks[2].line), /Base32/);
  assert.equal(text.split('\n').slice(blocks[2].lineNumber - 1, blocks[2].endLineNumber).join('\n'), blocks[2].line);
}));
test('pipe/tab import preserves empty columns and normalizes TOTP spacing', () => {
  assert.deepEqual(parseLine('a@example.com||r@example.com|jbsw y3dp'), { email: 'a@example.com', password: '', recoveryMail: 'r@example.com', twofa: 'JBSWY3DP' });
  assert.deepEqual(parseLine('a@example.com\tpassword\t\t'), { email: 'a@example.com', password: 'password', recoveryMail: '', twofa: '' });
  assert.equal(parseLine('a@example.com').email, 'a@example.com');
  assert.deepEqual(importLines('\na@example.com\r\n\r\nb@example.com').map(r => r.lineNumber), [2, 4]);
});
test('invalid import fails without echoing account secrets', () => {
  for (const line of ['bad|sensitive', 'a@example.com|sensitive|invalid', 'a@example.com|sensitive||123456', 'a@example.com|sensitive|||extra']) {
    assert.throws(() => parseLine(line), e => !e.message.includes('sensitive'));
  }
  assert.throws(() => importLines(''));
  assert.throws(() => importLines(Array(501).fill('a@example.com').join('\n')));
});
