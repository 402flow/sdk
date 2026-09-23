import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { Agent, ProxyAgent } from 'undici';
import { expect, it } from 'vitest';
import { createSandboxFetch } from '../examples/openai-agents-api/sandbox-probe.js';

it('uses the configured HTTPS proxy and CA while retaining TLS hostname verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-proxy-test-'));
  const certificate = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=probe.test',
      '-addext',
      'subjectAltName=DNS:probe.test',
      '-keyout',
      key,
      '-out',
      certificate,
    ],
    { stdio: 'ignore' },
  );
  const headers: Array<string | undefined> = [];
  const tunnels: Array<string | undefined> = [];
  const sockets = new Set<Duplex>();
  const target = httpsServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (req, res) => {
      headers.push(req.headers.authorization);
      res.end('ok');
    },
  );
  const proxy = httpServer();
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url);
    const upstream = connect(
      (target.address() as AddressInfo).port,
      '127.0.0.1',
      () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        client.pipe(upstream).pipe(client);
      },
    );
    sockets.add(client);
    sockets.add(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const transport = await createSandboxFetch(
    { Agent, ProxyAgent },
    {
      HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      SSL_CERT_FILE: certificate,
    },
  );
  try {
    // probe.test cannot resolve directly. Success requires CONNECT via our proxy,
    // with the supplied CA trusted and the original Authorization preserved.
    const response = await transport.fetch('https://probe.test/probe', {
      headers: { authorization: 'Bearer disposable-placeholder' },
      signal: AbortSignal.timeout(2000),
    });
    expect(await response.text()).toBe('ok');
    expect(tunnels).toEqual(['probe.test:443']);
    expect(headers).toEqual(['Bearer disposable-placeholder']);
    await expect(
      transport.fetch('https://wrong-host.test/probe', {
        signal: AbortSignal.timeout(2000),
      }),
    ).rejects.toThrow();
    expect(headers).toHaveLength(1);
  } finally {
    await transport.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});
