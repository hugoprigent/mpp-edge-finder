let chain: Promise<void> = Promise.resolve();

export async function withMppBrowserLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = chain;
  let release!: () => void;
  chain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => null);
  try {
    return await run();
  } finally {
    release();
  }
}
