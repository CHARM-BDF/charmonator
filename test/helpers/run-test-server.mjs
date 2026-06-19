import { createAndStart } from '../../lib/server.mjs';

let processes = null;
let isShuttingDown = false;

async function shutdown(exitCode) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    await processes?.cleanup?.();
    process.exit(exitCode);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown(0);
});

process.on('SIGINT', () => {
  void shutdown(0);
});

process.on('unhandledRejection', error => {
  console.error(error);
  void shutdown(1);
});

process.on('uncaughtException', error => {
  console.error(error);
  void shutdown(1);
});

processes = await createAndStart();
