const test = require('node:test');
const assert = require('node:assert/strict');
const { traced: t } = require('../trace-log');
const { gridBounds, horizontalBounds } = require('../window-layout');

test('gridBounds calculates slots correctly', t('test.gridBounds', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const b0 = gridBounds(area, 4, 0);
  assert.equal(b0.x, 0);
  assert.equal(b0.y, 0);
  assert.equal(b0.width, 500);
  assert.equal(b0.height, 900);
}));

test('horizontalBounds arranges single window to full screen width', t('test.horizontalBoundsSingle', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const b = horizontalBounds(area, 1, 0);
  assert.equal(b.left, 0);
  assert.equal(b.top, 0);
  assert.equal(b.width, 1920);
  assert.equal(b.height, 1040);
  assert.equal(b.windowState, 'normal');
}));

test('horizontalBounds arranges 2 windows side-by-side with gap', t('test.horizontalBoundsTwo', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const b0 = horizontalBounds(area, 2, 0, { gap: 8 });
  const b1 = horizontalBounds(area, 2, 1, { gap: 8 });

  // (1920 - 8) / 2 = 956
  assert.equal(b0.left, 0);
  assert.equal(b0.top, 0);
  assert.equal(b0.width, 956);
  assert.equal(b0.height, 1040);

  assert.equal(b1.left, 964);
  assert.equal(b1.top, 0);
  assert.equal(b1.width, 956);
  assert.equal(b1.height, 1040);
  assert.equal(b0.left + b0.width + 8, b1.left);
}));

test('horizontalBounds arranges 3 windows side-by-side with non-zero area offset', t('test.horizontalBoundsThreeWithOffset', () => {
  const area = { x: 100, y: 50, width: 1200, height: 800 };
  const b0 = horizontalBounds(area, 3, 0, { gap: 10, minWidth: 300 });
  const b1 = horizontalBounds(area, 3, 1, { gap: 10, minWidth: 300 });
  const b2 = horizontalBounds(area, 3, 2, { gap: 10, minWidth: 300 });

  // (1200 - 20) / 3 = 393.33 -> 393
  assert.equal(b0.left, 100);
  assert.equal(b0.top, 50);
  assert.equal(b0.width, 393);
  assert.equal(b0.height, 800);

  assert.equal(b1.left, 100 + 393 + 10);
  assert.equal(b1.top, 50);
  assert.equal(b1.width, 393);

  assert.equal(b2.left, 100 + 2 * (393 + 10));
  assert.equal(b2.top, 50);
  assert.equal(b2.width, 393);
}));
