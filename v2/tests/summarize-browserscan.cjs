const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const input = JSON.parse(fs.readFileSync(path.join(root, 'cdp-results.json')));
const field = (text, label) => text.match(new RegExp(`(?:^|\\n)${label}\\s*\\n([^\\n]+)`))?.[1] || null;
const results = input.results.map(r => {
  const file = r.output && path.join(r.output, 'page.txt');
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const scoreMatch = text.match(/Browser fingerprint authenticity\s*:?\s*(\d{1,3})\s*%/i);
  const score = scoreMatch ? Number(scoreMatch[1]) : null;
  const penalty = name => {
    const match = text.match(new RegExp(`${name}\\s*\\n-(\\d+)%`, 'i'));
    return match ? Number(match[1]) : 0;
  };
  const timezonePenalty = penalty('Different time zones');
  const ipPenalty = penalty('IP addresses are different');
  return { ...r, score, timezonePenalty, ipPenalty,
    antiDetectBrowserWarning: score === null ? null : /Anti-detect browser\s*\n-\d+%/i.test(text),
    penalties: [...text.matchAll(/(?:^|\n)([^\n]+)\s*\n-(\d+)%/g)].map(m => ({ reason: m[1].trim(), points: Number(m[2]) })),
    canvasWarning: score === null ? null : /Canvas Tampering/i.test(text),
    webglWarning: score === null ? null : /WebGL exception/i.test(text),
    botDetection: field(text, 'Bot Detection:'),
    renderer: field(text, 'Unmasked Renderer'), canvas: field(text, 'Canvas'),
    scoreExcludingTimezoneAndIp: score === null ? null : Math.min(100, score + timezonePenalty + ipPenalty) };
});
const valid = results.filter(r => r.score !== null);
const distribution = {};
for (const r of valid) distribution[r.score] = (distribution[r.score] || 0) + 1;
const summary = { version: input.version, mode: input.mode, checkedAt: new Date().toISOString(), planned: 20,
  measured: valid.length, unmeasured: 20 - valid.length, distribution,
  exactly90: valid.filter(r => r.score === 90).length,
  above90: valid.filter(r => r.score > 90).length,
  below90: valid.filter(r => r.score < 90).length,
  withoutCanvasOrWebglWarnings: valid.filter(r => !r.canvasWarning && !r.webglWarning).length,
  adjusted100: valid.filter(r => r.scoreExcludingTimezoneAndIp === 100).length,
  antiDetectBrowserWarnings: valid.filter(r => r.antiDetectBrowserWarning).length,
  note: 'Adjusted score only adds back the displayed timezone/IP penalties; it is not the site score. CDP diagnostics may affect detection. No native success rate claimed.', results };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(root, 'results.csv'), 'index,seed,score,timezonePenalty,ipPenalty,canvasWarning,webglWarning,antiDetectBrowserWarning,adjustedScore\n' + results.map(r => [r.index,r.seed,r.score,r.timezonePenalty,r.ipPenalty,r.canvasWarning,r.webglWarning,r.antiDetectBrowserWarning,r.scoreExcludingTimezoneAndIp].join(',')).join('\n') + '\n');
console.log(JSON.stringify({ measured: summary.measured, distribution, withoutCanvasOrWebglWarnings: summary.withoutCanvasOrWebglWarnings, adjusted100: summary.adjusted100 }));
