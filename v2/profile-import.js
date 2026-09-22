const { traced: t } = require('./trace-log');
const parseLine = t('import.parseLine', line => {
  let fields;
  if (/^\s*(Email|Password|Recovery|2FA key)\s*:/im.test(line)) {
    const values = {};
    for (const row of line.split(/\r?\n/)) {
      if (!row.trim()) continue;
      if (!Object.hasOwn(values, 'email') && /^[^\s:@|]+@[^\s@|]+\.[^\s@|]+\\?$/.test(row.trim())) {
        values.email = row.trim().replace(/\\$/, '').replace(/\\@/g, '@');
        continue;
      }
      const match = /^\s*(Email|Password|Recovery|2FA key)\s*:\s*(.*?)\s*$/i.exec(row);
      if (!match) throw new Error('Dòng không hợp lệ trong khối Email/Password/Recovery/2FA key.');
      const key = match[1].toLowerCase();
      if (Object.hasOwn(values, key)) throw new Error('Trường bị lặp trong khối tài khoản.');
      values[key] = match[2].replace(/\\$/, '').replace(/\\@/g, '@');
    }
    fields = ['email', 'password', 'recovery', '2fa key'].map(t('import.blockField', key => values[key] || ''));
  } else fields = line.split(/[|\t]/).map(t('import.trimField', s => s.trim()));
  if (fields.length > 4) throw new Error('Chỉ nhập tối đa 4 cột: Mail|Password|RecoveryMail|2FA.');
  const [email, password = '', recoveryMail = '', rawTwofa = ''] = fields;
  const isEmail = t('import.isEmail', value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  if (!isEmail(email)) throw new Error('Email không hợp lệ.');
  if (recoveryMail && !isEmail(recoveryMail)) throw new Error('Email khôi phục không hợp lệ.');
  const twofa = rawTwofa.replace(/\s+/g, '').toUpperCase();
  if (twofa && !/^[A-Z2-7]+=*$/.test(twofa)) throw new Error('Khóa 2FA phải là mã secret Base32.');
  if (password.length > 1024 || twofa.length > 512) throw new Error('Dữ liệu tài khoản quá dài.');
  return { email, password, recoveryMail, twofa };
});
const importLines = t('import.lines', text => {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Danh sách nhập quá lớn hoặc không hợp lệ.');
  const rows = text.split(/\r?\n/);
  let lines = [];
  if (/^\s*(Email|Password|Recovery|2FA key)\s*:/im.test(text)) {
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
module.exports = { parseLine, importLines };
