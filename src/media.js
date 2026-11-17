const extensions = new Map([
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/webp', ['.webp']],
  ['image/gif', ['.gif']],
  ['image/svg+xml', ['.svg']],
  ['audio/mpeg', ['.mp3']],
]);

export function mediaExtensions(mediaType) {
  return extensions.get(mediaType) ?? [];
}

export function decodeBase64(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`OpenRouter returned no ${label} data.`);
  }
  const bytes = Buffer.from(value, 'base64');
  const canonical = bytes.toString('base64');
  if (!bytes.length || (canonical !== value && canonical.replace(/=+$/, '') !== value)) {
    throw new Error(`OpenRouter returned invalid base64 ${label} data.`);
  }
  return bytes;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffImageType(bytes) {
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
}

export function imageMediaType(bytes, reportedType, transparent) {
  const detectedType = sniffImageType(bytes);
  const mediaType = reportedType ?? detectedType;
  if (mediaType === 'audio/mpeg' || !mediaExtensions(mediaType).length) {
    throw new Error('OpenRouter returned an unknown image format.');
  }
  if (transparent && detectedType !== 'image/png') {
    throw new Error('OpenRouter did not return the requested PNG for a transparent background.');
  }
  if (detectedType !== mediaType && (detectedType || mediaType !== 'image/svg+xml')) {
    throw new Error('The image bytes do not match the reported format.');
  }
  return mediaType;
}

export function validateMp3(bytes) {
  let frameOffset = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3' && bytes.length >= 10) {
    // ID3v2 stores the tag length as four seven-bit integers.
    const sizeBytes = bytes.subarray(6, 10);
    if (sizeBytes.every((byte) => byte < 128)) {
      frameOffset = 10 + sizeBytes.reduce((size, byte) => size * 128 + byte, 0);
      if (bytes[3] === 4 && (bytes[5] & 0x10)) frameOffset += 10;
    }
  }
  if (frameOffset + 4 < bytes.length) {
    const header = bytes.readUInt32BE(frameOffset);
    const version = (header >>> 19) & 3;
    const layer = (header >>> 17) & 3;
    const bitrate = (header >>> 12) & 15;
    const sampleRate = (header >>> 10) & 3;
    if (header >>> 21 === 0x7ff && version !== 1 && layer === 1 &&
        bitrate !== 0 && bitrate !== 15 && sampleRate !== 3) {
      return;
    }
  }
  throw new Error('OpenRouter returned invalid MP3 data.');
}
