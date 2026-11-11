import { ensureInitialized, jsDecodeImage, jsEncodeImage } from 'elheif';
self.onmessage = async (event: MessageEvent<{ id: number; type: 'decode' | 'encode'; data: Uint8Array; width?: number; height?: number }>) => {
  const { id, type, data, width, height } = event.data;
  try {
    await ensureInitialized();
    if (type === 'decode') {
      const result = jsDecodeImage(data);
      if (result.err || !result.data.length) throw new Error(result.err || 'No image found in this HEIC file.');
      const image = result.data[0];
      // elheif 0.1.0 appends the decoded plane twice (core/src/impl.cpp).
      // Its first width*height*4 bytes are already tightly packed RGBA.
      const size = image.width * image.height * 4;
      if (image.data.length < size || size > 128 * 1024 * 1024) throw new Error('The decoded HEIC dimensions are invalid or exceed 32 megapixels.');
      self.postMessage({ id, image: { ...image, data: new Uint8Array(image.data.slice(0, size)) } });
    } else {
      const result = jsEncodeImage(data, width!, height!);
      if (result.err) throw new Error(result.err);
      self.postMessage({ id, data: new Uint8Array(result.data) });
    }
  } catch (error) { self.postMessage({ id, error: String(error) }); }
};
