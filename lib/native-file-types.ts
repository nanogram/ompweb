import { getFileExt } from "./file-types";

// Documents and media only: never ask the OS to execute scripts, shortcuts or applications.
const NATIVE_VIEWER_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "jpe", "jfif", "gif", "bmp", "dib", "tif", "tiff", "webp", "avif", "heic", "heif", "ico", "svg", "svgz",
  "mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi", "mpeg", "mpg", "mts", "m2ts", "3gp", "3g2", "wmv", "flv",
  "mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "aif", "aiff", "wma",
  "pdf", "txt", "md", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "xml", "rtf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub",
]);

export function canOpenInSystemApp(filePath: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(filePath)) return false;
  const normalized = filePath.replace(/\\/g, "/");
  if (/^\/\/[?.]\//.test(normalized)) return false;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  // A colon in the basename can select a Windows alternate data stream.
  return !name.includes(":") && NATIVE_VIEWER_EXTENSIONS.has(getFileExt(filePath));
}
