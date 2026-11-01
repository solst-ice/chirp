// Reed–Solomon over GF(2^8) (primitive polynomial 0x11d, generator 2, fcr 0).
// Polynomials are arrays with the highest-degree coefficient first.
// Supports shortened codes (codeword length <= 255) and erasure hints.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a: number, b: number) => {
  if (b === 0) throw new Error('GF division by zero');
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};
const pow = (x: number, p: number) => EXP[(((LOG[x] * p) % 255) + 255) % 255];
const inv = (x: number) => EXP[255 - LOG[x]];

const polyScale = (p: number[], x: number) => p.map((c) => mul(c, x));

const polyAdd = (p: number[], q: number[]) => {
  const r = new Array<number>(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
};

const polyMul = (p: number[], q: number[]) => {
  const r = new Array<number>(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
};

const polyEval = (p: ArrayLike<number>, x: number) => {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
};

// Remainder of dividend / divisor (divisor must be monic).
const polyMod = (dividend: number[], divisor: number[]) => {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < divisor.length; j++) {
      if (divisor[j] !== 0) out[i + j] ^= mul(divisor[j], coef);
    }
  }
  return out.slice(out.length - (divisor.length - 1));
};

const generatorCache = new Map<number, number[]>();
const generator = (nsym: number) => {
  let g = generatorCache.get(nsym);
  if (!g) {
    g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
    generatorCache.set(nsym, g);
  }
  return g;
};

/** Returns data followed by nsym parity bytes. */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  if (data.length + nsym > 255) throw new Error('RS codeword longer than 255');
  const gen = generator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  out.set(data);
  return out;
}

const syndromes = (msg: ArrayLike<number>, nsym: number) => {
  const s = new Array<number>(nsym + 1).fill(0); // leading 0 keeps indices aligned with the math
  for (let i = 0; i < nsym; i++) s[i + 1] = polyEval(msg, pow(2, i));
  return s;
};

const forneySyndromes = (synd: number[], erasePos: number[], n: number) => {
  const fsynd = synd.slice(1);
  for (const p of erasePos) {
    const x = pow(2, n - 1 - p);
    for (let j = 0; j < fsynd.length - 1; j++) fsynd[j] = mul(fsynd[j], x) ^ fsynd[j + 1];
  }
  return fsynd;
};

// Berlekamp–Massey; returns null when there are more errors than the code can locate.
const errorLocator = (synd: number[], nsym: number, eraseCount: number) => {
  let errLoc = [1];
  let oldLoc = [1];
  const shift = synd.length > nsym ? synd.length - nsym : 0;
  for (let i = 0; i < nsym - eraseCount; i++) {
    const k = i + shift;
    let delta = synd[k];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[k - j]);
    oldLoc = [...oldLoc, 0];
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if ((errs - eraseCount) * 2 + eraseCount > nsym) return null;
  return errLoc;
};

// Chien search; positions are indices into the codeword.
const findErrors = (errLocReversed: number[], n: number) => {
  const errs = errLocReversed.length - 1;
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    if (polyEval(errLocReversed, pow(2, i)) === 0) pos.push(n - 1 - i);
  }
  return pos.length === errs ? pos : null;
};

const correctErrata = (msg: number[], synd: number[], errPos: number[]) => {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  let errLoc = [1];
  for (const c of coefPos) errLoc = polyMul(errLoc, polyAdd([1], [pow(2, c), 0]));

  const reversedSynd = synd.slice().reverse();
  const evaluator = polyMod(polyMul(reversedSynd, errLoc), [1, ...new Array(errLoc.length).fill(0)]).reverse();

  const X = coefPos.map((c) => pow(2, c));
  const out = msg.slice();
  for (let i = 0; i < X.length; i++) {
    const xiInv = inv(X[i]);
    let locPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) locPrime = mul(locPrime, 1 ^ mul(xiInv, X[j]));
    }
    if (locPrime === 0) return null;
    const y = mul(X[i], polyEval(evaluator.slice().reverse(), xiInv));
    out[errPos[i]] ^= div(y, locPrime);
  }
  return out;
};

/**
 * Decode a codeword (data + nsym parity). `erasures` are codeword indices known
 * to be unreliable. Returns the corrected data bytes, or null if uncorrectable.
 */
export function rsDecode(codeword: Uint8Array, nsym: number, erasures: number[] = []): Uint8Array | null {
  const n = codeword.length;
  if (n > 255 || n <= nsym) return null;
  if (erasures.length > nsym) return null;
  const msg = Array.from(codeword);
  for (const p of erasures) msg[p] = 0;

  let synd = syndromes(msg, nsym);
  if (synd.every((s) => s === 0)) return Uint8Array.from(msg.slice(0, n - nsym));

  const fsynd = forneySyndromes(synd, erasures, n);
  const errLoc = errorLocator(fsynd, nsym, erasures.length);
  if (!errLoc) return null;
  const errPos = findErrors(errLoc.slice().reverse(), n);
  if (!errPos) return null;

  const corrected = correctErrata(msg, synd, [...erasures, ...errPos]);
  if (!corrected) return null;
  synd = syndromes(corrected, nsym);
  if (synd.some((s) => s !== 0)) return null;
  return Uint8Array.from(corrected.slice(0, n - nsym));
}
