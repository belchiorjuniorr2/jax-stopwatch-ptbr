// Recebe /api/callback/<id> via rewrite (vercel.json) — chamado pela rotina do Grok Bot
import { handleCallback } from '../lib/jobs.js';
export default handleCallback;
