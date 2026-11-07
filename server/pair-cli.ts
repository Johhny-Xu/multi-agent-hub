// Alias for `openmausbot pair`: docs and images reference dist-server/pair-cli.js.
import { main } from "./cli.ts";
import { exitAfterFlush } from "./exit.ts";

main(["pair", ...process.argv.slice(2)]).then(exitAfterFlush, (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exitAfterFlush(1);
});
