// Process entrypoint for the forge. The grading harness drives this program
// entirely from outside: it tells us where it lives through $MAKEFUN_ENV_URL,
// we bring the HTTP server up on whichever port the kernel picks, report that
// port back, and idle until the harness says the run is finished — only then
// do we close the server and exit successfully. The server itself is the raw
// TCP listener from app.ts (which speaks HTTP/1.1 itself, for speed); the
// surface this file needs from it is just listen/address/close, so the type
// below is node:net's Server, not node:http's.

import type { Server } from 'node:net';
import { createApp } from './app.ts';

// Timing knobs for talking to the harness, gathered in one place so the
// retry behaviour below stays easy to follow.
const KNOBS = {
  requestTimeoutMs: 30_000, // hard ceiling for a single harness call
  backoffStartMs: 250, // wait after the first failed attempt
  backoffLimitMs: 2_000, // waits never grow past this
} as const;

/** setTimeout, promisified. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff clock: each tick waits twice as long as the previous
 * one, from backoffStartMs up to backoffLimitMs. reset() restarts it short.
 */
class RetryClock {
  #span: number = KNOBS.backoffStartMs;

  async tick(): Promise<void> {
    const current = this.#span;
    this.#span = Math.min(this.#span * 2, KNOBS.backoffLimitMs);
    await wait(current);
  }

  reset(): void {
    this.#span = KNOBS.backoffStartMs;
  }
}

/** The harness answered in a way the lifecycle contract forbids. */
class ContractBreach extends Error {}

/** Where the harness lives, normalised so paths can be appended cleanly. */
function harnessBase(): string {
  const base = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (base === '') {
    throw new Error('MAKEFUN_ENV_URL is empty or unset; nowhere to register');
  }
  return base;
}

/** One call to the harness, always bounded by the per-request timeout. */
async function envCall(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(KNOBS.requestTimeoutMs),
  });
}

/**
 * Tell the harness which port we ended up on. Transient trouble — refused
 * connections, timeouts, unexpected statuses — is retried with backoff. A 400
 * or 405 means the registration itself is rejected, so that aborts instead.
 */
async function announcePort(base: string, port: number): Promise<void> {
  const clock = new RetryClock();
  for (;;) {
    let res: Response;
    try {
      res = await envCall(base, '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      await clock.tick(); // network-level failure: wait, then try again
      continue;
    }
    if (res.status === 200 || res.status === 409) return; // noted (or already was)
    if (res.status === 400 || res.status === 405) {
      throw new ContractBreach(`registration refused: HTTP ${res.status}`);
    }
    await clock.tick(); // any other status: back off and retry
  }
}

/**
 * Poll the harness until it reports the run is over. Any failure along the
 * way — request error, non-JSON body, done not set — just means "not yet".
 */
async function awaitCompletion(base: string): Promise<void> {
  const clock = new RetryClock();
  for (;;) {
    let finished = false;
    try {
      const res = await envCall(base, '/done');
      if (res.ok) {
        const body: unknown = await res.json();
        finished =
          typeof body === 'object' &&
          body !== null &&
          (body as { done?: unknown }).done === true;
        if (!finished) clock.reset(); // healthy answer, just not done yet
      }
    } catch {
      finished = false; // timeout, network error or bad JSON: keep waiting
    }
    if (finished) return;
    await clock.tick();
  }
}

/** Start listening on an ephemeral port and resolve with the chosen port. */
function bindEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server bound without a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function run(): Promise<void> {
  const base = harnessBase();
  const server = createApp();
  const port = await bindEphemeral(server);
  console.log(`forge is up on ephemeral port ${port}`);
  try {
    await announcePort(base, port);
    console.log('harness has our port; holding until it calls time');
    await awaitCompletion(base);
    console.log('harness signalled completion; winding down');
  } finally {
    server.close();
  }
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
