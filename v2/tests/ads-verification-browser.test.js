const test = require('node:test');
const assert = require('node:assert/strict');
const { traced: t } = require('../trace-log');
const {
  cleanCustomerId,
  formatCustomerId,
  getActiveOrFirstPage,
  navigateToAds,
  checkGoogleLoginRedirect,
  clickStartNow,
  selectMccAccount,
  clickSearchMagnifier,
  typeCustomerIdInSearch,
  waitForSearchResultAndOpenInNewWindow,
  startVerificationFlow,
} = require('../ads-verification-browser');

test('cleanCustomerId and formatCustomerId format 10-digit IDs correctly', t('test.mccIdFormatting', () => {
  assert.equal(cleanCustomerId('123-456-7890'), '1234567890');
  assert.equal(cleanCustomerId('1234567890'), '1234567890');
  assert.equal(cleanCustomerId(''), '');

  assert.equal(formatCustomerId('1234567890'), '123-456-7890');
  assert.equal(formatCustomerId('123-456-7890'), '123-456-7890');
  assert.equal(formatCustomerId('abc'), 'abc');
}));

test('getActiveOrFirstPage returns visible page or first page', t('test.getActiveOrFirstPage', async () => {
  const mockPage1 = {
    evaluate: async () => false,
    bringToFront: async () => {},
  };
  const mockPage2 = {
    evaluate: async () => true,
    bringToFront: async () => {},
  };
  const mockBrowser = {
    pages: async () => [mockPage1, mockPage2],
  };

  const page = await getActiveOrFirstPage(mockBrowser);
  assert.equal(page, mockPage2);
}));

test('navigateToAds calls page.goto with https://ads.google.com/', t('test.navigateToAds', async () => {
  let visitedUrl = '';
  const mockPage = {
    goto: async (url, opts) => {
      visitedUrl = url;
    },
  };
  await navigateToAds(mockPage);
  assert.equal(visitedUrl, 'https://ads.google.com/');
}));

test('checkGoogleLoginRedirect throws if page redirected to Google login', t('test.checkGoogleLoginRedirect', () => {
  const loggedOutPage = {
    url: () => 'https://accounts.google.com/signin/v2/identifier',
  };
  assert.throws(() => checkGoogleLoginRedirect(loggedOutPage), /Profile chưa đăng nhập Gmail/);

  const loggedInPage = {
    url: () => 'https://ads.google.com/aw/overview',
  };
  assert.doesNotThrow(() => checkGoogleLoginRedirect(loggedInPage));
}));

test('clickStartNow skips if already in Ads overview or account chooser', t('test.clickStartNowSkip', async () => {
  const mockPage = {
    url: () => 'https://ads.google.com/aw/overview',
  };
  const result = await clickStartNow(mockPage);
  assert.equal(result, true);
}));

test('clickStartNow clicks CTA button when on landing page', t('test.clickStartNowClicks', async () => {
  const mockPage = {
    url: () => 'https://ads.google.com/home/',
    evaluate: async fn => true,
  };
  const result = await clickStartNow(mockPage, 1000);
  assert.equal(result, true);
}));

test('selectMccAccount succeeds immediately if URL already has MCC ocid', t('test.selectMccAlreadyInMcc', async () => {
  const mockPage = {
    url: () => 'https://ads.google.com/aw/overview?ocid=1234567890',
  };
  const result = await selectMccAccount(mockPage, '123-456-7890', 1000);
  assert.equal(result.success, true);
  assert.equal(result.alreadyInMcc, true);
}));

test('selectMccAccount searches and clicks matching MCC account', t('test.selectMccSearchAndClick', async () => {
  let evaluateCallCount = 0;
  const mockPage = {
    url: () => 'https://ads.google.com/um/identity',
    evaluate: async fn => {
      evaluateCallCount++;
      return true; // Simulates successfully finding and clicking the element
    },
  };
  const result = await selectMccAccount(mockPage, '1234567890', 2000);
  assert.equal(result.success, true);
  assert.equal(result.matchedMcc, '123-456-7890');
}));

test('startVerificationFlow runs full workflow successfully', t('test.startVerificationFlow', async () => {
  const mockPage = {
    url: () => 'https://ads.google.com/aw/overview?ocid=9998887776',
    evaluate: async fn => true,
    goto: async () => {},
    bringToFront: async () => {},
  };
  const mockBrowser = {
    pages: async () => [mockPage],
  };

  const result = await startVerificationFlow(mockBrowser, { id: 'test-profile-1', mccId: '9998887776' });
  assert.equal(result.ok, true);
  assert.equal(result.mccId, '999-888-7776');
  assert.equal(result.status, 'mcc_selected');
}));

test('clickSearchMagnifier finds and clicks search button', t('test.clickSearchMagnifier', async () => {
  const mockPage = {
    evaluate: async fn => true,
  };
  const result = await clickSearchMagnifier(mockPage, 1000);
  assert.equal(result, true);
}));

test('typeCustomerIdInSearch focuses input and types formatted customer ID', t('test.typeCustomerIdInSearch', async () => {
  const typedChars = [];
  const mockPage = {
    evaluate: async fn => true,
    keyboard: {
      type: async (char, opts) => {
        typedChars.push(char);
      },
    },
  };
  const result = await typeCustomerIdInSearch(mockPage, '1234567890', 10);
  assert.equal(result.success, true);
  assert.equal(result.typedId, '123-456-7890');
  assert.equal(typedChars.join(''), '123-456-7890');
}));

test('waitForSearchResultAndOpenInNewWindow finds account and opens in new window', t('test.waitForSearchResultAndOpenInNewWindow', async () => {
  const openedUrls = [];
  const mockBrowser = {
    newPage: async () => ({
      goto: async url => {
        openedUrls.push(url);
      },
    }),
  };

  const mockPage = {
    evaluate: async () => ({
      found: true,
      href: '/aw/overview?ocid=111222333&workspaceId=0',
      name: 'Account Test Name',
      idText: '123-456-7890',
      rect: { x: 20, y: 100, width: 400, height: 40 }
    }),
  };

  const result = await waitForSearchResultAndOpenInNewWindow(mockPage, '123-456-7890', 2000, mockBrowser);
  assert.equal(result.success, true);
  assert.equal(result.account.idText, '123-456-7890');
  assert.equal(result.openedInWindow, true);
  assert.match(result.openedUrl, /https:\/\/ads\.google\.com\/aw\/overview\?ocid=111222333/);
  assert.equal(openedUrls.length, 1);
}));


