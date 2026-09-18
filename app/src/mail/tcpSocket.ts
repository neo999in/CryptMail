/**
 * `OpenSocket` over `react-native-tcp-socket` — the only file in the app that
 * opens a raw connection.
 *
 * Present only in a dev build that links the library's native module
 * (`NativeModules.TcpSockets`). The web build and Expo Go have no such module,
 * so `openTcpSocket` is null there and `config.ts` reports IMAP as unavailable
 * rather than offering a sign-in that cannot connect. The library is required
 * lazily, behind that check, because it builds a `NativeEventEmitter` over the
 * module at import time.
 *
 * ## The host check this file adds
 *
 * Read on 2026-09-18 from the library's Android source (6.4.3,
 * `TcpSocketClient.java`): a TLS socket is built from the platform's default
 * `SSLSocketFactory`, so the **chain** is validated against the system trust
 * store — but it is created unconnected, and STARTTLS wraps the socket under
 * its IP address. Java's raw `SSLSocket` does no endpoint identification, so
 * nothing checks that the certificate names the server that was asked for. Any
 * certificate any public CA issued, for any domain, would be accepted.
 *
 * So the check is done here, before a single byte is written: the peer
 * certificate's subject CN must name the host (`certificateMatchesHost`). The
 * library reports the CN but not the subjectAltNames, so a server whose CN is a
 * *different* one of its names is refused — the safe way to be wrong, and the
 * message says which name the certificate carried. The same unconnected socket
 * means no SNI is sent either, so a host that serves many domains from one
 * address may present its default certificate and be refused for the same
 * reason.
 */
import { NativeModules } from 'react-native';

import { certificateMatchesHost, MailSocket, OpenSocket, TransportError } from './socket';

/** The slice of the library this file uses. Its own typings are JSDoc-generated and loose. */
type LibSocket = {
  on(event: 'data', listener: (data: Uint8Array | string) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  write(data: Uint8Array): boolean;
  destroy(): void;
};
type LibTlsSocket = LibSocket & { getPeerCertificate(): Promise<{ subject?: { CN?: string } } | null> };
type Lib = {
  Socket: new () => LibSocket & { connect(options: object, callback?: () => void): LibSocket };
  TLSSocket: new (socket: LibSocket, options?: object) => LibTlsSocket;
  connectTLS(options: object, callback?: () => void): LibTlsSocket;
};

/** Refuse to wait forever on a host that swallows the SYN. */
const CONNECT_TIMEOUT_MS = 20_000;

let lib: Lib | null = null;
function load(): Lib {
  if (!lib) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('react-native-tcp-socket');
    lib = (m.default ?? m) as Lib;
  }
  return lib;
}

async function verifyPeer(tls: LibTlsSocket, host: string): Promise<void> {
  let commonName: string | undefined;
  try {
    commonName = (await tls.getPeerCertificate())?.subject?.CN;
  } catch (e) {
    throw new TransportError(`Could not read ${host}'s certificate: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!certificateMatchesHost(commonName, host)) {
    throw new TransportError(
      commonName
        ? `${host} presented a certificate for "${commonName}", not for ${host}. CryptMail refused the connection.`
        : `${host} presented a certificate that names no host. CryptMail refused the connection.`,
    );
  }
}

/**
 * Wrap one library socket, from the moment it exists.
 *
 * `events` is the object whose listeners to use: after a STARTTLS upgrade the
 * plain and TLS objects share one native id and *both* receive every event, so
 * exactly one of them may be listened to or each chunk would arrive twice.
 *
 * Data is buffered until a listener is attached. A server speaks first — the
 * IMAP greeting, the SMTP 220 — and it can arrive while the certificate is
 * still being checked, before anyone has called `onData`; an event emitter with
 * no listener would simply drop it.
 */
function wrap(events: LibSocket, host: string): MailSocket {
  let closed = false;
  let closeError: Error | undefined;
  const closeListeners: ((error?: Error) => void)[] = [];
  let dataListener: ((chunk: Uint8Array) => void) | null = null;
  const pending: Uint8Array[] = [];

  const finish = (error?: Error) => {
    if (closed) return;
    closed = true;
    closeError = error;
    for (const l of closeListeners) l(error);
  };
  events.on('error', (e) => finish(e instanceof Error ? e : new TransportError(String(e))));
  events.on('close', () => finish());
  events.on('data', (data) => {
    const chunk = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (dataListener) dataListener(chunk);
    else pending.push(chunk);
  });

  return {
    write(bytes) {
      if (closed) throw new TransportError(`The connection to ${host} is closed.`);
      events.write(bytes);
    },
    async startTls() {
      const tls = new (load().TLSSocket)(events, {});
      try {
        await verifyPeer(tls, host);
      } catch (e) {
        events.destroy();
        throw e;
      }
    },
    close() {
      if (!closed) events.destroy();
    },
    onData(listener) {
      dataListener = listener;
      for (const chunk of pending.splice(0)) listener(chunk);
    },
    onClose(listener) {
      if (closed) listener(closeError);
      else closeListeners.push(listener);
    },
  };
}

function open({ host, port, tls }: { host: string; port: number; tls: boolean }): Promise<MailSocket> {
  const { Socket, connectTLS } = load();
  return new Promise<MailSocket>((resolve, reject) => {
    const options = { host, port, connectTimeout: CONNECT_TIMEOUT_MS };
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      outcome();
    };
    const fail = (e: unknown) =>
      settle(() =>
        reject(
          e instanceof TransportError
            ? e
            : new TransportError(`Could not connect to ${host}:${port}: ${e instanceof Error ? e.message : String(e)}`),
        ),
      );

    if (tls) {
      let wrapped: MailSocket | null = null;
      const socket = connectTLS(options, () => {
        verifyPeer(socket, host).then(
          () => settle(() => resolve(wrapped!)),
          (e) => {
            socket.destroy();
            fail(e);
          },
        );
      });
      wrapped = wrap(socket, host);
      wrapped.onClose((e) => fail(e ?? new TransportError('the server closed the connection')));
    } else {
      const socket = new Socket();
      const wrapped = wrap(socket, host);
      wrapped.onClose((e) => fail(e ?? new TransportError('the server closed the connection')));
      socket.connect(options, () => settle(() => resolve(wrapped)));
    }
  });
}

/** Whether this build can open a socket at all. */
export const hasSocketModule = Boolean((NativeModules as Record<string, unknown> | undefined)?.TcpSockets);

export const openTcpSocket: OpenSocket | null = hasSocketModule ? open : null;
