// Native BrowserScan sampling: no CDP, WebDriver or page script injection.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ProfileStore } = require('../profile-store');
const { inspectChromium, BUNDLED_CHROMIUM, launchArgs } = require('../chromium-runtime');
const engine = require('../engine-config');
if (engine.major !== '148') throw new Error('This comparison requires engine 148');
const root = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(__dirname, '../artifacts/browserscan148-20-'));
const store = new ProfileStore(path.join(root, 'data'));
const runtime = inspectChromium(BUNDLED_CHROMIUM);
if (!runtime.ready) throw new Error(runtime.error);
const profiles = store.list().length ? store.list() : Array.from({ length: 20 }, (_, i) => store.create({ name: `BrowserScan test ${i + 1}`, gpu: 'auto' }));
if (profiles.length !== 20) throw new Error('Expected exactly 20 profiles');
const reportFile = path.join(root, 'results.json');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile)) : { version: runtime.version, mode: 'Native windows, no CDP or WebDriver', startedAt: new Date().toISOString(), total: 20, results: [] };
function save() { fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2)); }
save();
console.log(`BATCH_ROOT ${root}`);
(async () => {
  for (const [i, profile] of profiles.entries()) {
    if (report.results.some(r => r.index === i + 1 && r.score !== null)) continue;
    const output = path.join(root, `test-${String(i + 1).padStart(2, '0')}`);
    fs.mkdirSync(output, { recursive: true });
    const args = launchArgs(store.directory(profile.id), 'https://iphey.com/', profile.fingerprint);
    args[args.length - 1] = 'https://www.browserscan.net/';
    const plan = path.join(output, 'launch-plan.json');
    fs.writeFileSync(plan, JSON.stringify({ root: output, executable: BUNDLED_CHROMIUM, version: runtime.version, profiles: [{ profileId: profile.id, fingerprint: profile.fingerprint, args }] }, null, 2));
    const log = fs.openSync(path.join(output, 'capture.log'), 'w');
    const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'chromium-native.ps1'), '-PlanFile', plan, '-CaptureOnly', '-WaitSeconds', '30'], { windowsHide: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    const file = path.join(output, 'profile-1.txt');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '';
    const match = text.match(/Browser fingerprint authenticity\s*:?\s*(\d{1,3})\s*%/i);
    const score = match && Number(match[1]) <= 100 ? Number(match[1]) : null;
    report.results = report.results.filter(r => r.index !== i + 1);
    report.results.push({ index: i + 1, profileId: profile.id, seed: profile.fingerprint.seed, score, captureExitCode: code, output, timezoneWarning: score === null ? null : /Different time zones/i.test(text), ipWarning: score === null ? null : /IP addresses are different/i.test(text), canvasWarning: score === null ? null : /Canvas Tampering/i.test(text), webglWarning: score === null ? null : /WebGL exception/i.test(text) });
    save();
    console.log(`RESULT ${i + 1}/20 score=${score} captureExit=${code}`);
    if (score === null) throw new Error('Native result unavailable; pause rather than count an invalid measurement. Resume with the same root.');
  }
  report.finishedAt = new Date().toISOString(); save();
  console.log(`BATCH_COMPLETE ${root}`);
})().catch(e => { report.error = e.stack; save(); console.error(e); process.exitCode = 1; });
