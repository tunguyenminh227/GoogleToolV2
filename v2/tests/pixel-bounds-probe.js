// Serialized into the local browser probe; this function has no Node dependencies.
module.exports = function pixelBoundsProbe() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'rgb(40,80,120)'; ctx.fillRect(0, 0, 16, 16);
  const crop = ctx.getImageData(-4, -4, 12, 12).data;
  let negativeCrop = crop.length === 12 * 12 * 4;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const i = (y * 12 + x) * 4;
    if (x < 4 || y < 4) negativeCrop &&= crop.slice(i, i + 4).every(value => value === 0);
    else negativeCrop &&= crop[i + 3] === 255;
  }

  const gpuCanvas = document.createElement('canvas');
  gpuCanvas.width = gpuCanvas.height = 16;
  const gl = gpuCanvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 unavailable for pixel bounds probe');
  const color = [40, 80, 120, 255];
  gl.clearColor(40 / 255, 80 / 255, 120 / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.pixelStorei(gl.PACK_ROW_LENGTH, 12);
  gl.pixelStorei(gl.PACK_SKIP_ROWS, 1);
  gl.pixelStorei(gl.PACK_SKIP_PIXELS, 2);
  const packed = new Uint8Array(12 * 10 * 4).fill(237);
  gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, packed);
  let packedReadback = gl.getError() === gl.NO_ERROR;
  for (let y = 0; y < 10; y++) for (let x = 0; x < 12; x++) {
    const written = y >= 1 && y < 9 && x >= 2 && x < 10;
    for (let c = 0; c < 4; c++) packedReadback &&= packed[(y * 12 + x) * 4 + c] === (written ? color[c] : 237);
  }
  gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);

  let floatReadback = null;
  if (gl.getExtension('EXT_color_buffer_float')) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 8, 8, 0, gl.RGBA, gl.FLOAT, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Float framebuffer incomplete');
    gl.clearColor(0.25, 0.5, 0.75, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const floats = new Float32Array(8 * 8 * 4);
    gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.FLOAT, floats);
    floatReadback = gl.getError() === gl.NO_ERROR && floats.every((value, i) => value === [0.25, 0.5, 0.75, 1][i % 4]);
    gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture);
  }
  return { negativeCrop, packedReadback, floatReadback };
};
