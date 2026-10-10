/**
 * A software smart station for your terminal. It signs taps exactly like the
 * ESP32 firmware and verifies the signed replies.
 *
 *   npm run station -w apps/api -- --id <station-id> --key <station-key-hex> [--mqtt mqtt://localhost:1883]
 *
 * Keys match the Wokwi simulator's cards:
 *   k  key fob   C0:FF:EE:99   (assign it to yourself as a badge first)
 *   g  green     11:22:33:44   TW-0101
 *   y  yellow    55:66:77:88   MM-0201
 *   r  red       AA:BB:CC:DD   TW-0103 (calibration expired)
 *   n  NFC tag   04:11:22:33:44:55:66   VC-0301
 *   p  arm "report a problem" for the next tap
 *   or type any UID, like DE:AD:BE:EF.   q to quit.
 */
import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import mqtt from 'mqtt';
import { normalizeUid } from '../lib/uid.js';
import { sign, type StationMessage } from '../stations/crypto.js';
import { replyCanonical, type SignedReply } from '../stations/gateway.js';

const { values: args } = parseArgs({
  options: {
    id: { type: 'string' },
    key: { type: 'string' },
    mqtt: { type: 'string', default: process.env.MQTT_URL ?? 'mqtt://localhost:1883' },
    prefix: { type: 'string', default: 'tooltrace/v1' },
  },
});
if (!args.id || !args.key || !/^[0-9a-f]{64}$/i.test(args.key)) {
  console.error('Usage: npm run station -w apps/api -- --id <station-id> --key <64-hex-char station key> [--mqtt url]');
  process.exit(1);
}
const stationId = args.id;
const key = Buffer.from(args.key, 'hex');
const cards: Record<string, string> = { k: 'C0FFEE99', g: '11223344', y: '55667788', r: 'AABBCCDD', n: '04112233445566' };

const client = await mqtt.connectAsync(args.mqtt!, { clientId: `tt-sim-${stationId.slice(0, 8)}` });
await client.subscribeAsync(`${args.prefix}/stations/${stationId}/replies`, { qos: 1 });

let last = 0;
let pending: { seq: number; resolve: (r: SignedReply | null) => void } | null = null;
client.on('message', (_topic, payload) => {
  const r = JSON.parse(payload.toString()) as SignedReply;
  const { sig, ...rest } = r;
  const expected = createHmac('sha256', key).update(replyCanonical(stationId, rest)).digest('hex');
  if (!pending || r.seq !== pending.seq || expected !== sig) {
    console.log('  (ignored a reply that was not signed for us)');
    return;
  }
  pending.resolve(r);
  pending = null;
});

async function send(type: 'hello' | 'tap', uid = '', flag: 'ok' | 'problem' = 'ok') {
  const seq = Math.max(Date.now(), last + 1);
  last = seq;
  const m: StationMessage = { v: 1, seq, type, uid, flag };
  const reply = new Promise<SignedReply | null>((resolve) => {
    pending = { seq, resolve };
    setTimeout(() => resolve(null), 5000);
  });
  await client.publishAsync(`${args.prefix}/stations/${stationId}/events`, JSON.stringify({ ...m, sig: sign(key, stationId, m) }), { qos: 1 });
  const r = await reply;
  const lamp = { green: '\x1b[42m  \x1b[0m', red: '\x1b[41m  \x1b[0m', amber: '\x1b[43m  \x1b[0m', blue: '\x1b[44m  \x1b[0m' };
  console.log(r ? `  ${lamp[r.led]}  ${r.l1.padEnd(20)} ${r.l2}` : '  No answer (is the API running with the same broker and master key?)');
}

console.log(`Station ${stationId} connected to ${args.mqtt}`);
await send('hello');
const rl = createInterface({ input: process.stdin, output: process.stdout });
let problem = false;
const prompt = () => process.stdout.write(problem ? 'tap (problem armed)> ' : 'tap> ');
prompt();
// Works both interactively and with piped input (one tap per line).
for await (const line of rl) {
  const input = line.trim();
  if (input === 'q' || input === 'quit') break;
  if (input === 'p') {
    problem = true;
    console.log('  Problem armed: the next tool tap will be returned as damaged.');
  } else if (input) {
    const uid = cards[input.toLowerCase()] ?? normalizeUid(input);
    if (!uid) {
      console.log('  Keys: k g y r n (cards), p (report a problem), q (quit), or a UID like DE:AD:BE:EF');
    } else {
      console.log(`  tap ${uid.match(/.{2}/g)!.join(':')}`);
      await send('tap', uid, problem ? 'problem' : 'ok');
      problem = false;
    }
  }
  prompt();
}
rl.close();
await client.endAsync();
