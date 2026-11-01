// Modem benchmark: delivery rate and goodput under simulated room conditions.
// Usage: node scripts/bench.ts [trials]

import { MODEMS } from '../src/modem/profiles.ts';
import { FrameType } from '../src/modem/types.ts';
import { rng, room, roundTrip } from '../test/channel.ts';

const trials = Number(process.argv[2] ?? 10);
const PAYLOAD = 100;
const conditions = [
  { name: 'clean', snrDb: undefined, echo: 0 },
  { name: '20 dB', snrDb: 20, echo: 0 },
  { name: '10 dB + echo', snrDb: 10, echo: 0.3 },
  { name: '5 dB + echo', snrDb: 5, echo: 0.4 },
  { name: '0 dB + echo', snrDb: 0, echo: 0.4 },
  { name: '-5 dB + echo', snrDb: -5, echo: 0.5 },
];

console.log(`${PAYLOAD}-byte payload, ${trials} trials per cell, 44.1 kHz -> 48 kHz, random ±150 ppm drift`);
console.log('SNR is wideband white noise relative to signal power.\n');
console.log(['profile'.padEnd(10), 'raw b/s', 'goodput b/s', ...conditions.map((c) => c.name.padStart(13))].join(' '));

for (const modem of MODEMS) {
  const cells: string[] = [];
  for (const c of conditions) {
    let ok = 0;
    for (let t = 0; t < trials; t++) {
      const r = rng(1000 * t + 17);
      const payload = Uint8Array.from({ length: PAYLOAD }, () => Math.floor(r() * 256));
      const { frames } = roundTrip(modem, { type: FrameType.Text, payload }, 44100, {
        rxRate: 48000,
        clockPpm: (r() * 2 - 1) * 150,
        snrDb: c.snrDb,
        echoes: c.echo ? room(t + 1, c.echo) : undefined,
        leadSeconds: 0.1 + r() * 0.5,
        seed: t + 1,
      });
      if (frames.length === 1 && frames[0].frame.payload.every((b, i) => b === payload[i])) ok++;
    }
    cells.push(`${Math.round((100 * ok) / trials)}%`.padStart(13));
  }
  const goodput = (PAYLOAD * 8) / modem.airtime(PAYLOAD);
  console.log([modem.id.padEnd(10), modem.rawBitRate.toFixed(0).padStart(7), goodput.toFixed(0).padStart(11), ...cells].join(' '));
}
