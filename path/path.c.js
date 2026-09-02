/** First vertical slice of src/path/path.c. */
export function translatePath(path) {
  if (typeof path !== "string") throw new TypeError("path must be a string");
  return path === "/" ? "/etc" : path;
}

export function translateArgv(argv) {
  return argv.map(translatePath);
}
