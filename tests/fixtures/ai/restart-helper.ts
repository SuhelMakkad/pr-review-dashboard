import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export async function unusedPort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (!address || typeof address === 'string') throw new Error('No local test port available.');
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return address.port;
}

export async function startServer(
  directory: string,
  port: number,
  delay: number,
  webRoot?: string,
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(
        new URL('../../../apps/server/tests/fixtures/restart-server.mjs', import.meta.url),
      ),
    ],
    {
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL('../../../apps/server/tsconfig.json', import.meta.url),
        ),
        REVIEW_RESTART_DATA: directory,
        REVIEW_RESTART_PORT: String(port),
        REVIEW_RESTART_DELAY: String(delay),
        REVIEW_RESTART_WEB_ROOT: webRoot ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Recovery test server did not start: ${output}`));
    }, 10_000);

    child.stdout!.on('data', (data) => {
      output += data.toString();

      if (output.includes('ready\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr!.on('data', (data) => {
      output += data.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Recovery test server exited ${code}: ${output}`));
    });
  });

  return child;
}

export async function stopServer(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill(signal);
  });
}
