// Local stand-in for Cloudflare Access signing keys, used only to smoke-test the real
// Worker in `wrangler dev`: serves a JWKS at /certs and mints tokens at /token?email=…
import { createServer } from 'node:http';
import { createDevSigner } from '../dev/devauth';

const port = Number(process.env.PORT ?? 8792);
const signer = await createDevSigner();
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/certs') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ keys: await signer.jwks() }));
  }
  if (url.pathname === '/token') return res.end(await signer.issue(url.searchParams.get('email') ?? ''));
  res.statusCode = 404;
  res.end();
}).listen(port, '127.0.0.1', () => console.log(`local access keys on http://127.0.0.1:${port}`));
