// Servidor local (LAN) — mesmo código da Vercel. Uso: node server.js
import http from 'node:http';
import fs from 'node:fs';
import { handleVoz, handleReset, handleHealth } from './lib/handler.js';
import { handleAgent, handleJob, handleCallback } from './lib/jobs.js';

// Carrega .env simples (sem dependências), sem sobrescrever variáveis já definidas
if (fs.existsSync(new URL('./.env', import.meta.url))) {
  for (const line of fs.readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== '' && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const routes = { '/api/voz': handleVoz, '/api/reset': handleReset, '/api/health': handleHealth, '/api/agent': handleAgent,
  // destinos dos rewrites do vercel.json (?id=&op=) — a Vercel pode servir tudo por este server.js
  '/api/job': handleJob, '/api/callback': handleCallback };
const prefixRoutes = [['/api/job/', handleJob], ['/api/callback/', handleCallback]];
const port = parseInt(process.env.PORT || '8787', 10);

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const h = routes[path] || prefixRoutes.find(([p]) => path.startsWith(p))?.[1];
  if (!h) { res.statusCode = 404; return res.end('not found'); }
  try { await h(req, res); } catch (e) { res.statusCode = 500; res.end('erro'); }
}).listen(port, '0.0.0.0', () => {
  console.log(`[relay] ouvindo em http://0.0.0.0:${port}  (rotas: ${Object.keys(routes).join(', ')})`);
  if (!process.env.DEVICE_TOKEN) console.warn('[relay] AVISO: DEVICE_TOKEN vazio — todas as requisições serão recusadas.');
});
