// On Linux a pipe takes writes asynchronously, so `process.exit` right after `console.error` can drop that line; a write
// callback fires only once its data is out.
export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  const flushed = (stream: NodeJS.WriteStream) => new Promise<void>((done) => stream.write("", () => done()));
  void Promise.all([flushed(process.stdout), flushed(process.stderr)]).then(() => process.exit(code));
}
