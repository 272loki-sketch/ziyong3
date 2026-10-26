/** Stop the directly spawned canary server before removing its temporary HOME. */
export async function stopCanaryChild(child, { graceMs = 5_000, killMs = 5_000 } = {}) {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (!child || !child.pid || exited()) return;

  const stop = (signal, timeoutMs) => new Promise((resolve, reject) => {
    const finish = (value) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    try {
      if (exited()) finish(true);
      else child.kill(signal);
    } catch (error) {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      reject(error);
    }
  });

  if (await stop('SIGTERM', graceMs)) return;
  if (!await stop('SIGKILL', killMs)) throw new Error(`Canary child ${child.pid} did not exit after SIGKILL`);
}
