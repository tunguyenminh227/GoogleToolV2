const { traced: t } = require('./trace-log');

const isPasskeyBlob = t('import.isPasskey', str => {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (s.length < 30) return false;
  try {
    const json = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
    return Boolean(json && (json.credentialId || json.rpId || json.privateKey || json.id));
  } catch (_) {
    return s.startsWith('ey') && s.length > 50;
  }
});

const isEmail = t('import.isEmail', value => Boolean(value && typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)));

const is2FA = t('import.is2FA', value => {
  if (!value || typeof value !== 'string') return false;
  const clean = value.replace(/\s+/g, '').toUpperCase();
  return clean.length >= 16 && clean.length <= 64 && /^[A-Z2-7]+=*$/.test(clean);
});

const parseLine = t('import.parseLine', line => {
  let email = '';
  let password = '';
  let recoveryMail = '';
  let rawTwofa = '';
  let securityCode = '';
  let passkey = '';

  if (/^\s*(Email|Password|Recovery|2FA key|2FA|Security code|Backup code|Passkey)\s*:/im.test(line)) {
    const values = {};
    for (const row of line.split(/\r?\n/)) {
      if (!row.trim()) continue;
      if (!Object.hasOwn(values, 'email') && /^[^\s:@|]+@[^\s@|]+\.[^\s@|]+\\?$/.test(row.trim())) {
        values.email = row.trim().replace(/\\$/, '').replace(/\\@/g, '@');
        continue;
      }
      const match = /^\s*(Email|Password|Recovery|Recovery\s*Mail|Recovery\s*Email|2FA\s*key|2FA|Security\s*code|Securitycode|Backup\s*code|Passkey)\s*:\s*(.*?)\s*$/i.exec(row);
      if (!match) throw new Error('Dòng không hợp lệ trong khối thông tin tài khoản.');
      let key = match[1].toLowerCase().replace(/\s+/g, '');
      if (key === 'recoverymail' || key === 'recoveryemail') key = 'recovery';
      if (key === '2fa') key = '2fakey';
      if (key === 'backupcode') key = 'securitycode';
      if (Object.hasOwn(values, key)) throw new Error('Trường bị lặp trong khối tài khoản.');
      values[key] = match[2].replace(/\\$/, '').replace(/\\@/g, '@');
    }
    email = values.email || '';
    password = values.password || '';
    recoveryMail = values.recovery || '';
    rawTwofa = values['2fakey'] || '';
    securityCode = values.securitycode || '';
    passkey = values.passkey || '';
  } else {
    const rawFields = line.split(/[|\t]/).map(t('import.trimField', s => s.trim()));
    if (rawFields.length > 6) throw new Error('Chỉ nhập tối đa 6 cột: Mail|Password|RecoveryMail|2FA|SecurityCode|Passkey.');

    email = rawFields[0] || '';

    // Trường hợp 1: email||password|2fa... (Cột 1 rỗng, cột 2 là mật khẩu không phải email)
    // Người dùng hoặc seller bỏ qua recovery mail hoặc đặt double pipe "||" giữa email và password
    if (rawFields[1] === '' && rawFields[2] && !isEmail(rawFields[2])) {
      password = rawFields[2];
      recoveryMail = '';
      rawTwofa = rawFields[3] || '';
      if (rawFields.length === 5) {
        if (isPasskeyBlob(rawFields[4])) passkey = rawFields[4];
        else securityCode = rawFields[4];
      } else if (rawFields.length >= 6) {
        securityCode = rawFields[4];
        passkey = rawFields[5];
      }
    }
    // Trường hợp 2: email|recoveryMail|password|2fa... (Cột 1 là email khôi phục, cột 2 là mật khẩu)
    else if (isEmail(rawFields[1]) && rawFields[2] && !isEmail(rawFields[2])) {
      recoveryMail = rawFields[1];
      password = rawFields[2];
      rawTwofa = rawFields[3] || '';
      if (rawFields.length === 5) {
        if (isPasskeyBlob(rawFields[4])) passkey = rawFields[4];
        else securityCode = rawFields[4];
      } else if (rawFields.length >= 6) {
        securityCode = rawFields[4];
        passkey = rawFields[5];
      }
    }
    // Trường hợp 3: email|password|2fa... (Không có cột recovery mail, cột 2 là 2FA hợp lệ thay vì email)
    else if (rawFields[1] && rawFields[2] && !isEmail(rawFields[2]) && is2FA(rawFields[2])) {
      password = rawFields[1];
      recoveryMail = '';
      rawTwofa = rawFields[2];
      if (rawFields.length === 4) {
        if (isPasskeyBlob(rawFields[3])) passkey = rawFields[3];
        else securityCode = rawFields[3];
      } else if (rawFields.length >= 5) {
        securityCode = rawFields[3];
        passkey = rawFields[4];
      }
    }
    // Trường hợp mặc định: Mail|Password|RecoveryMail|2FA|SecurityCode|Passkey
    else {
      password = rawFields[1] || '';
      recoveryMail = rawFields[2] || '';
      rawTwofa = rawFields[3] || '';
      if (rawFields.length === 5) {
        if (isPasskeyBlob(rawFields[4])) passkey = rawFields[4];
        else securityCode = rawFields[4];
      } else if (rawFields.length >= 6) {
        securityCode = rawFields[4];
        passkey = rawFields[5];
      }
    }
  }

  if (!isEmail(email)) throw new Error('Email không hợp lệ.');
  if (recoveryMail && !isEmail(recoveryMail)) throw new Error('Email khôi phục không hợp lệ.');
  const twofa = rawTwofa.replace(/\s+/g, '').toUpperCase();
  if (twofa && !/^[A-Z2-7]+=*$/.test(twofa)) throw new Error('Khóa 2FA phải là mã secret Base32.');
  if (passkey.startsWith('{') && passkey.endsWith('}')) {
    try {
      JSON.parse(passkey);
      passkey = Buffer.from(passkey, 'utf8').toString('base64');
    } catch (_) {}
  }
  if (password.length > 1024 || twofa.length > 512 || securityCode.length > 512 || passkey.length > 8192) throw new Error('Dữ liệu tài khoản quá dài.');
  const result = { email, password, recoveryMail, twofa };
  if (securityCode) result.securityCode = securityCode;
  if (passkey) result.passkey = passkey;
  return result;
});

const importLines = t('import.lines', text => {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Danh sách nhập quá lớn hoặc không hợp lệ.');
  const rows = text.split(/\r?\n/);
  let lines = [];
  if (/^\s*(Email|Password|Recovery|2FA key|2FA|Security code|Backup code|Passkey)\s*:/im.test(text)) {
    let current;
    for (let i = 0; i < rows.length; i++) {
      if (/^\s*Email\s*:/i.test(rows[i]) || /^[^\s:@|]+@[^\s@|]+\.[^\s@|]+\\?$/.test(rows[i].trim())) {
        current = { line: rows[i], lineNumber: i + 1, endLineNumber: i + 1 };
        lines.push(current);
      } else if (current) { current.line += '\n' + rows[i]; current.endLineNumber = i + 1; }
      else if (rows[i].trim()) throw new Error('Khối tài khoản phải bắt đầu bằng Email: hoặc một địa chỉ email. Hãy dán lại đầy đủ khối.');
    }
  } else lines = rows.map(t('import.lineNumber', (line, i) => ({ line, lineNumber: i + 1 }))).filter(t('import.nonempty', item => item.line.trim()));
  if (!lines.length) throw new Error('Nhập ít nhất một email, mỗi dòng một profile.');
  if (lines.length > 500) throw new Error('Mỗi lần tạo tối đa 500 profile.');
  return lines;
});

module.exports = { parseLine, importLines, isPasskeyBlob };
