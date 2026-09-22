const fs = require('node:fs');
const path = require('node:path');
const { ProfileStore } = require('../profile-store');
const { BUNDLED_CHROMIUM, inspectChromium, launchArgs } = require('../chromium-runtime');
const root = fs.mkdtempSync(path.join(__dirname, '..', 'artifacts', 'chromium-native-'));
const store = new ProfileStore(path.join(root, 'data'));
const runtime = inspectChromium(BUNDLED_CHROMIUM);
if (!runtime.ready) throw new Error(runtime.error);
const profiles = [1, 2].map(index => {
  const profile = store.create({ name: `Native Chromium ${runtime.version} test ${index}`, gpu: 'auto' });
  return { variant: `seed-${index}`, profileId: profile.id, fingerprint: profile.fingerprint,
    args: launchArgs(store.directory(profile.id), 'https://iphey.com/', profile.fingerprint) };
});
if (process.argv.includes('--reopen')) profiles.push({ ...profiles[0], variant: 'reopen-first-profile' });
const plan = path.join(root, 'launch-plan.json');
fs.writeFileSync(plan, JSON.stringify({ root, executable: BUNDLED_CHROMIUM, version: runtime.version, profiles }, null, 2));
console.log(plan);
