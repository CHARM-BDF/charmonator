/* file: server.mjs */

/*
Why is lib/server.mjs a separate file you ask?

provider: openai
prompt: |
    I try to reuse my server.mjs file main program from unit tests with a createAndStart() function.

    This works for running from bash and running from mocha.

    However, under pm2, some kind of dynamic import is used which changes the value of argv[1].

    What is the appropriate way to test if we are being run as a main program that works for all three methods of invocation (mocha test, bash, pm2)?

            const currentFilePath = fileURLToPath(import.meta.url);
            console.log({
              "event":"startup",
              url: import.meta.url,
              currentFilePath,
              argv1: process.argv[1]
              })
            if (process.argv[1] === currentFilePath) {
              // Kick off
              await createAndStart();
            }
        =>
            1|charmonator  | {
            1|charmonator  |   event: 'startup',
            1|charmonator  |   url: 'file:///Users/udnadmin/usr/code/projects/charmonator/server.mjs',
            1|charmonator  |   currentFilePath: '/Users/udnadmin/usr/code/projects/charmonator/server.mjs',
            1|charmonator  |   argv1: '/Users/udnadmin/.local/lib/node_modules/pm2/lib/ProcessContainerFork.js'
            1|charmonator  | }
response: |
    Unfortunately, there isn't a foolproof single-file "ES-module equivalent" of if (require.main === module) that always works under Node, Mocha, and PM2. In particular, PM2 often spawns your code via a wrapper script (ProcessContainerFork.js), which breaks the usual "compare process.argv[1] to import.meta.url" approach.

    ---------------------------------------------------
    1) The usual pattern (and why it fails under PM2)
    ---------------------------------------------------

    For many ESM scripts, you will see something like:

      import { fileURLToPath } from 'node:url';
      import { createAndStart } from './lib.js';

      const scriptPath = fileURLToPath(import.meta.url);

      // 'Typical' check: if launched directly from CLI (node myScript.mjs):
      if (process.argv[1] === scriptPath) {
        createAndStart();
      }

    This logic works when a user directly types node myScript.mjs or when mocha is told to run that exact file. But under PM2, process.argv[1] is typically /path/to/ProcessContainerFork.js (the PM2 wrapper), not your scriptPath, so the comparison fails.

    ---------------------------------------------------
    2) The recommended fix: separate "library" vs. "runner"
    ---------------------------------------------------

    Rather than trying to detect "am I main?" in the same file, a more robust solution is:

     • Put all startup logic into a function (createAndStart).
     • Create a separate small CLI entry point (e.g. cli.mjs) that imports your code and calls createAndStart.
     • Point PM2, Mocha, and your bash scripts at cli.mjs when you actually want to run the service.

    Example folder structure:

      ├── server.mjs
      ├── cli.mjs
      └── test/
          └── test_server.mjs

    Then:

    server.mjs:

      // Library code only
      export async function createAndStart() {
        // your logic
      }

    cli.mjs:

      import { createAndStart } from './server.mjs';
      createAndStart();

    test/test_server.mjs:

      import { createAndStart } from '../server.mjs';
      // or import { somethingToTest } from '../server.mjs';
      // and run your tests without needing to guess whether it's "main."

    Now you:

     • Run from bash with node cli.mjs.
     • Under Mocha, either import server.mjs or test a function from server.mjs.
     • Under PM2, do pm2 start cli.mjs (or specify node cli.mjs in your process config).

    In all cases, you avoid the fragile "which file is in process.argv[1]?" check. Instead, you either call createAndStart() from a dedicated CLI or import it in tests.

    ---------------------------------------------------
    3) Why separate files is the surest method
    ---------------------------------------------------

    In Node's ESM world, there is no built-in import.meta.main or require.main-style fallback that always tells you unambiguously "I am the user-run entry file." Various tools (Mocha, PM2, bundlers, and so on) can launch your code through intermediate scripts or loaders that break process.argv assumptions.

    Hence the simplest and most reliable pattern is:

     • Put all real logic into a library module.
     • Have a tiny "runner" file that calls that logic when you actually mean "start the service now."
     • Point PM2 and your shell scripts at the runner.
     • Tests just import your library logic directly.

    This avoids having to do any uncertain environment sniffing and works uniformly in Bash, Mocha, PM2, or any other environment that can import or run a Node script.
*/

import { createAndStart } from './lib/server.mjs';

// Kick off
await createAndStart();

