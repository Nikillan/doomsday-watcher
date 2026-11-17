// Node 18+ runner (local test or GitHub Actions backup).
//   node scripts/run.mjs --once      → one scan, print results, no Telegram
//   node scripts/run.mjs --loop 350  → tick every 60s for 350 minutes, state in state.json
// Env: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { scan, tick, sendTelegram, formatShows } from '../src/core.js';

const args = process.argv.slice(2);
const STATE_FILE = 'state.json';

if (args.includes('--once')) {
  const r = await scan();
  console.log('English versions:', r.languages.map((l) => `${l.title}=${l.key}`).join(', '));
  console.log(formatShows(r.shows).replace(/<\/?b>/g, '') || 'No matching shows.');
  process.exit(0);
}

const minutes = Number(args[args.indexOf('--loop') + 1] || 350);
const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = process.env;
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID');
const notify = (t) => sendTelegram(TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, t);

let state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const end = Date.now() + minutes * 60000;
while (Date.now() < end) {
  const started = Date.now();
  try {
    const out = await tick(state, notify);
    state = out.state;
    if (out.changed) writeFileSync(STATE_FILE, JSON.stringify(state));
    console.log(new Date().toISOString(), typeof out.result === 'string' ? out.result : `${out.result.shows.length} shows`);
  } catch (e) {
    console.error(new Date().toISOString(), 'tick failed:', e.message);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, 60000 - (Date.now() - started))));
}
