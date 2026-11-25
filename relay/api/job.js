// Recebe /api/job/<id>, /api/job/<id>/audio e /api/job/<id>/cancel via rewrites (vercel.json)
import { handleJob } from '../lib/jobs.js';
export default handleJob;
