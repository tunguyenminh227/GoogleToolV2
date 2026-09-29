const { traced } = require('./trace-log');
const gridBounds = traced('windows.gridBounds', (area, count, slot) => {
  const width = Math.min(500, area.width);
  const height = Math.min(900, area.height);
  const strideX = width;
  const strideY = height;
  const columns = Math.max(1, Math.floor(area.width / strideX));
  const rows = Math.max(1, Math.floor(area.height / strideY));
  const capacity = columns * rows;
  const position = slot % capacity;
  const offset = Math.floor(slot / capacity) * 28;
  return { x: area.x + (position % columns) * strideX + offset,
    y: area.y + Math.floor(position / columns) * strideY + offset,
    width, height };
});
const horizontalBounds = traced('windows.horizontalBounds', (area, count, index, options = {}) => {
  const gap = options.gap !== undefined ? options.gap : 0;
  const minWidth = options.minWidth || 380;
  const total = Math.max(1, count);
  const winWidth = total <= 1 ? area.width : Math.max(minWidth, Math.floor((area.width - (total - 1) * gap) / total));
  const winHeight = area.height;
  const x = area.x + index * (winWidth + gap);
  const y = area.y;
  return {
    left: Math.round(x),
    top: Math.round(y),
    width: Math.round(winWidth),
    height: Math.round(winHeight),
    windowState: 'normal'
  };
});

module.exports = { gridBounds, horizontalBounds };
