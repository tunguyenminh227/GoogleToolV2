const test = require('node:test');
const assert = require('node:assert/strict');

test('extracts authorization code correctly from raw code or redirect URL', () => {
  function extractCode(raw) {
    let code = raw.trim();
    if (raw.includes('code=')) {
      try {
        const parsedUrl = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
        const codeParam = parsedUrl.searchParams.get('code');
        if (codeParam) code = codeParam;
      } catch (_) {
        const match = raw.match(/[?&]code=([^&]+)/);
        if (match) code = decodeURIComponent(match[1]);
      }
    }
    return code;
  }

  // 1. Raw code
  assert.equal(extractCode('4/0AbCdEf12345'), '4/0AbCdEf12345');

  // 2. Full URL with code parameter
  assert.equal(
    extractCode('http://127.0.0.1/?code=4%2F0AbCdEf12345&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fadwords'),
    '4/0AbCdEf12345'
  );

  // 3. URL without protocol
  assert.equal(
    extractCode('127.0.0.1:8080/?code=my-secret-code&scope=adwords'),
    'my-secret-code'
  );
});

test('generates valid OAuth2 Google Ads authorization URL', () => {
  const clientId = '123456789-xyz.apps.googleusercontent.com';
  const redirectUri = 'http://127.0.0.1';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords',
    access_type: 'offline',
    prompt: 'consent',
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://accounts.google.com');
  assert.equal(parsed.pathname, '/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'), clientId);
  assert.equal(parsed.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(parsed.searchParams.get('scope'), 'https://www.googleapis.com/auth/adwords');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(parsed.searchParams.get('prompt'), 'consent');
});
