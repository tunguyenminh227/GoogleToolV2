// Parse copied text from our own native test windows. Never edits the test page.
const fs = require('node:fs');
const path = require('node:path');

function parseResult(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const score = normalized.match(/^([0-9]{1,3})\s*\nMX Score\s*$/mi);
  const detailScore = normalized.match(/^MX Score\s*\n([0-9]{1,3})\s*$/mi);
  const confirmed = /Your Digital Identity Looks/i.test(normalized) && score && detailScore && score[1] === detailScore[1] && Number(score[1]) <= 100;
  const flags = {};
  for (const name of ['hasCDP', 'hasWebdriver', 'hasUserAgent', 'hasNavigator']) {
    const match = normalized.match(new RegExp(`^${name}\\s*\\n(true|false)\\s*$`, 'm'));
    flags[name] = match ? match[1] === 'true' : null;
  }
  return { score: confirmed ? Number(score[1]) : null,
    signals: [...normalized.matchAll(/^Detected .+$/gm)].map(match => match[0]), flags };
}

function summarize(planFile) {
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8').replace(/^\uFEFF/, ''));
  const profiles = plan.profiles.map((profile, index) => {
    const file = path.join(plan.root, `profile-${index + 1}.txt`);
    return { index: index + 1, profileId: profile.profileId, variant: profile.variant,
      gpu: profile.fingerprint.gpu, ...parseResult(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') };
  });
  const result = { version: plan.version, checkedAt: new Date().toISOString(),
    mode: 'Native window capture and copied page text; no CDP or WebDriver',
    profiles, scores: profiles.map(profile => profile.score),
    targetReached: profiles.length > 0 && profiles.every(profile => profile.score === 100 && profile.signals.length === 0 && Object.values(profile.flags).every(value => value === false)) };
  fs.writeFileSync(path.join(plan.root, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  const result = summarize(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.targetReached ? 0 : 1;
}
module.exports = { parseResult, summarize };
