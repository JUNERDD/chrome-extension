import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const fixtureDirectory = fileURLToPath(new URL('.', import.meta.url));
const port = Number.parseInt(process.argv[2] ?? '41731', 10);

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  response.setHeader('Cache-Control', 'no-store');

  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }

  if (url.pathname === '/api/failure') {
    response.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Fixture-Result': 'controlled-failure',
    });
    response.end(JSON.stringify({ ok: false, message: 'controlled failure' }));
    return;
  }

  const fileName = url.pathname === '/' || url.pathname === '/sensitive'
    ? 'sensitive.html'
    : url.pathname.slice(1);
  const filePath = join(fixtureDirectory, fileName);

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || !filePath.startsWith(fixtureDirectory)) throw new Error('Not a fixture file');
    response.writeHead(200, {
      'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
      'Content-Length': fileStat.size,
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
});

server.listen(port, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
