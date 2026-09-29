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
  for (const line of ['bad|sensitive', 'a@example.com|sensitive|invalid', 'a@example.com|sensitive||123456', 'a@example.com|sensitive||||||extra']) {
    assert.throws(() => parseLine(line), e => !e.message.includes('sensitive'));
  }
  assert.throws(() => importLines(''));
  assert.throws(() => importLines(Array(501).fill('a@example.com').join('\n')));
});

test('supports importing security code and passkey', () => {
  const userPasskeyBlob = 'eyJjcmVkZW50aWFsSWQiOiJRaGRKTDc3ZFVMc0JvdGRHK1RnaXJkWHYvQUwrT043MmNpdnd1V2JiTno0PSIsImlzUmVzaWRlbnRDcmVkZW50aWFsIjp0cnVlLCJycElkIjoiZ29vZ2xlLmNvbSJ9';
  const userLine = `lynhatruc65391@gmail.com|Nochuachetdau@123|alibabatrap1@gmail.com|5dyumonzlnzc6l3z7uabyirr3ida32kt|${userPasskeyBlob}`;
  const parsed5 = parseLine(userLine);
  assert.equal(parsed5.email, 'lynhatruc65391@gmail.com');
  assert.equal(parsed5.password, 'Nochuachetdau@123');
  assert.equal(parsed5.recoveryMail, 'alibabatrap1@gmail.com');
  assert.equal(parsed5.twofa, '5DYUMONZLNZC6L3Z7UABYIRR3IDA32KT');
  assert.equal(parsed5.passkey, userPasskeyBlob);
  assert.equal(parsed5.securityCode, undefined);

  // 5 columns with security code (not passkey)
  const secLine = 'lynhatruc65391@gmail.com|Nochuachetdau@123|alibabatrap1@gmail.com|5dyumonzlnzc6l3z7uabyirr3ida32kt|12345678';
  const parsedSec = parseLine(secLine);
  assert.equal(parsedSec.securityCode, '12345678');
  assert.equal(parsedSec.passkey, undefined);

  // 6 columns with both security code and passkey
  const fullLine = `lynhatruc65391@gmail.com|Nochuachetdau@123|alibabatrap1@gmail.com|5dyumonzlnzc6l3z7uabyirr3ida32kt|12345678|${userPasskeyBlob}`;
  const parsed6 = parseLine(fullLine);
  assert.equal(parsed6.securityCode, '12345678');
  assert.equal(parsed6.passkey, userPasskeyBlob);

  // Multi-line block with security code and passkey
  const blockText = `Email: test@example.com\nPassword: pwd\nRecovery: rec@example.com\n2FA: jbswy3dp\nSecurity code: 999888\nPasskey: ${userPasskeyBlob}`;
  const parsedBlock = parseLine(blockText);
  assert.equal(parsedBlock.securityCode, '999888');
  assert.equal(parsedBlock.passkey, userPasskeyBlob);
});

test('supports flexible formats without recovery mail or with Mail||Password', () => {
  // Format from user with empty recovery mail and double pipe
  const userLine = 'hugh.thomas287920@gmail.com||duckdog39|zhox 5hdl svbp fitx slrq jdxo xxxy jrw3|18598491720|https://sms222.us?token=bu1YU466uH08101718';
  const parsedUser = parseLine(userLine);
  assert.equal(parsedUser.email, 'hugh.thomas287920@gmail.com');
  assert.equal(parsedUser.password, 'duckdog39');
  assert.equal(parsedUser.recoveryMail, '');
  assert.equal(parsedUser.twofa, 'ZHOX5HDLSVBPFITXSLRQJDXOXXXYJRW3');
  assert.equal(parsedUser.securityCode, '18598491720');
  assert.equal(parsedUser.passkey, 'https://sms222.us?token=bu1YU466uH08101718');

  // Format with RecoveryMail at column 2
  const recAt2 = 'user@example.com|recov@example.com|mypassword|5dyumonzlnzc6l3z7uabyirr3ida32kt';
  const parsedRec2 = parseLine(recAt2);
  assert.equal(parsedRec2.email, 'user@example.com');
  assert.equal(parsedRec2.recoveryMail, 'recov@example.com');
  assert.equal(parsedRec2.password, 'mypassword');
  assert.equal(parsedRec2.twofa, '5DYUMONZLNZC6L3Z7UABYIRR3IDA32KT');

  // Format without recovery mail: Email|Password|2FA
  const noRecLine = 'user@example.com|mypassword|5dyumonzlnzc6l3z7uabyirr3ida32kt';
  const parsedNoRec = parseLine(noRecLine);
  assert.equal(parsedNoRec.email, 'user@example.com');
  assert.equal(parsedNoRec.password, 'mypassword');
  assert.equal(parsedNoRec.recoveryMail, '');
  assert.equal(parsedNoRec.twofa, '5DYUMONZLNZC6L3Z7UABYIRR3IDA32KT');

  // Format without recovery mail: Email|Password|2FA|SecurityCode
  const noRecWithSec = 'user@example.com|mypassword|5dyumonzlnzc6l3z7uabyirr3ida32kt|12345678';
  const parsedNoRecSec = parseLine(noRecWithSec);
  assert.equal(parsedNoRecSec.email, 'user@example.com');
  assert.equal(parsedNoRecSec.password, 'mypassword');
  assert.equal(parsedNoRecSec.recoveryMail, '');
  assert.equal(parsedNoRecSec.twofa, '5DYUMONZLNZC6L3Z7UABYIRR3IDA32KT');
  assert.equal(parsedNoRecSec.securityCode, '12345678');
});
