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
module.exports = { gridBounds };
