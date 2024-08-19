/**
 * @file Contains utility functions for handling paths.
 */

import path from "path-browserify";
import { fileURLToPath } from "node:url";
import { ensureStartsWith } from "./String.ts";

export const posix = path.posix;
export const win32 = path.win32;
export const delimiter = posix.delimiter;
export const sep = path.posix.sep;

export const basename = posix.basename.bind(posix);
export const dirname = posix.dirname.bind(posix);
export const extname = posix.extname.bind(posix);
export const format = posix.format.bind(posix);
export const isAbsolute = posix.isAbsolute.bind(posix);
export const join = posix.join.bind(posix);
export const normalize = posix.normalize.bind(posix);
export const parse = posix.parse.bind(posix);
export const relative = posix.relative.bind(posix);

/**
 * Resolves a sequence of paths or path segments into an absolute path.
 *
 * @param pathSegments - The sequence of path segments to resolve.
 * @returns The resolved absolute path.
 */
export function resolve(...pathSegments: string[]): string {
  let path = posix.resolve(...pathSegments);
  path = toPosixPath(path);
  const match = path.match(/.:[^:]*$/);
  return match?.[0] ?? path;
}

/**
 * Converts a given path to a POSIX-style path by replacing backslashes with forward slashes.
 *
 * @param path - The path to convert.
 * @returns The POSIX-style path.
 */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Converts a buffer containing a path to a POSIX-style buffer by replacing backslashes with forward slashes.
 *
 * @param buffer - The buffer to convert.
 * @returns A new buffer containing the POSIX-style path.
 */
export function toPosixBuffer(buffer: Buffer): Buffer {
  return Buffer.from(toPosixPath(buffer.toString()));
}

/**
 * Gets the filename from the `import.meta.url`, converting it to a POSIX-style path.
 *
 * @param importMetaUrl - The `import.meta.url` from which to extract the filename.
 * @returns The POSIX-style filename.
 */
export function getFilename(importMetaUrl: string): string {
  return toPosixPath(fileURLToPath(importMetaUrl));
}

/**
 * Gets the directory name from the `import.meta.url`, converting it to a POSIX-style path.
 *
 * @param importMetaUrl - The `import.meta.url` from which to extract the directory name.
 * @returns The POSIX-style directory name.
 */
export function getDirname(importMetaUrl: string): string {
  return dirname(getFilename(importMetaUrl));
}

/**
 * Normalizes a given path by ensuring it is relative, adding "./" if necessary.
 *
 * @param path - The path to normalize.
 * @returns The normalized path, starting with "./" if it was relative.
 */
export function normalizeIfRelative(path: string): string {
  if (path[0] === "/" || path.includes(":")) {
    return path;
  }

  return ensureStartsWith(path, "./");
}
