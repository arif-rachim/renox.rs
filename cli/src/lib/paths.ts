/** A path with `/` separators, whatever `path.sep` is: artifact paths, route ids and hash inputs are POSIX. */
export const toPosix = (p: string): string => p.replaceAll("\\", "/");
