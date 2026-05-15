import { createAndStart } from '../../lib/server.mjs';

export function useManagedServerFixture({ perTest = false } = {}) {
  let processes = null;

  const startHook = perTest ? beforeEach : before;
  startHook(async function() {
    this.timeout(10000);
    processes = await createAndStart();
  });

  async function stopCurrentProcesses(test) {
    if (!processes?.cleanup) {
      return;
    }
    const current = processes;
    processes = null;
    await current.cleanup({ force: Boolean(test?.timedOut) });
  }

  afterEach(async function() {
    if (!perTest || !processes) {
      return;
    }
    this.timeout(10000);
    await stopCurrentProcesses(this.currentTest);
  });

  if (!perTest) {
    afterEach(async function() {
      if (!this.currentTest?.timedOut || !processes) {
        return;
      }
      this.timeout(10000);
      await stopCurrentProcesses(this.currentTest);
    });

    after(async function() {
      this.timeout(10000);
      await stopCurrentProcesses(this.currentTest);
    });
  }
}
