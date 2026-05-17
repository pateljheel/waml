const binaryExtensions = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".pyc",
  ".so",
  ".tar",
  ".tgz",
  ".war",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);
const textContentTypePrefixes = ["text/"];
const textContentTypes = new Set([
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/csv",
  "application/javascript",
  "application/x-javascript",
  "application/sql",
]);
const binaryContentTypePrefixes = ["image/", "audio/", "video/", "font/"];
const binaryContentTypes = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument",
  "application/msword",
  "application/vnd.ms-powerpoint",
  "application/java-archive",
]);

const binarySniffBytes = 4096;

export function shouldSkipObjectByKey(objectKey: string) {
  const lowerKey = objectKey.toLocaleLowerCase();

  for (const extension of binaryExtensions) {
    if (lowerKey.endsWith(extension)) {
      return true;
    }
  }

  return false;
}

export function isGzipObject(objectKey: string) {
  return objectKey.toLocaleLowerCase().endsWith(".gz");
}

function normalizeContentType(contentType?: string | null) {
  if (!contentType) {
    return null;
  }

  return contentType.split(";")[0]?.trim().toLocaleLowerCase() || null;
}

export function shouldSkipObjectByContentType(contentType?: string | null) {
  const normalized = normalizeContentType(contentType);

  if (!normalized) {
    return false;
  }

  if (textContentTypes.has(normalized)) {
    return false;
  }

  for (const prefix of textContentTypePrefixes) {
    if (normalized.startsWith(prefix)) {
      return false;
    }
  }

  if (binaryContentTypes.has(normalized)) {
    return true;
  }

  for (const prefix of binaryContentTypePrefixes) {
    if (normalized.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

export function looksBinaryBuffer(chunkBuffer: Buffer) {
  const sample = chunkBuffer.subarray(0, binarySniffBytes);

  if (sample.length === 0) {
    return false;
  }

  let suspiciousBytes = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;
    const isExtendedUtf8Byte = byte >= 128;

    if (!isAllowedControl && !isPrintableAscii && !isExtendedUtf8Byte) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / sample.length > 0.2;
}
