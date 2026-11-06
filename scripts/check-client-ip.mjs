#!/usr/bin/env node
/**
 * After a deploy: can a visitor choose the IP address the rate limits see?
 *
 * The API keys signed-out rate limits on the visitor's address — read from the
 * header named by CLIENT_IP_HEADER, or from X-Forwarded-For via TRUST_PROXY.
 * That is only safe if the platform in front OVERWRITES those headers. If it
 * passes a visitor's own value through, anyone can claim a fresh address on
 * every request and the limits on login, registration and password reset stop
 * meaning anything. This cannot be known from the code; only the live platform
 * can answer it.
 *
 * How it tells: the limiter reports how many requests remain for the key it
 * used, in the RateLimit response header. Two requests with two different
 * forged addresses should land in the SAME bucket (your real address), so the
 * remaining count drops between them. If it does not drop, each forged value
 * got a bucket of its own — the header is spoofable.
 *
 * Usage: node scripts/check-client-ip.mjs https://your-app.ondigitalocean.app
 * Spends six requests of your general API budget. Run it signed out (it is):
 * signed-in requests are keyed by user, which would hide the answer.
 */

const base = process.argv[2]?.replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/check-client-ip.mjs <app URL>');
  process.exit(2);
}

/** A documentation-range address (RFC 5737), different on every call. */
const fake = () => `203.0.113.${1 + Math.floor(Math.random() * 254)}`;

async function remaining(headers = {}) {
  const res = await fetch(`${base}/api/levels`, { headers });
  const header = res.headers.get('ratelimit') ?? '';
  const match = header.match(/remaining=(\d+)/);
  if (!match) {
    throw new Error(`No RateLimit header in the response (status ${res.status}). Is ${base} the app URL?`);
  }
  return Number(match[1]);
}

/** Two requests forging `name`; true if both landed in one bucket. */
async function ignored(name) {
  const first = await remaining({ [name]: fake() });
  let second = await remaining({ [name]: fake() });
  // Two fakes can collide by chance; one retry rules that out.
  if (second >= first) second = await remaining({ [name]: fake() });
  console.log(`  ${name.padEnd(18)} forged twice → remaining ${first}, then ${second}`);
  return second < first;
}

const start = await remaining();
console.log(`Your real address: ${start} requests remaining in this window.\n`);

let ok = true;
for (const name of ['x-forwarded-for', 'do-connecting-ip']) {
  if (await ignored(name)) {
    console.log(`  ✓ a forged ${name} is ignored\n`);
  } else {
    ok = false;
    console.log(`  ✗ a forged ${name} gets its own bucket — the address is spoofable\n`);
  }
}

if (ok) {
  console.log('PASS: visitors cannot choose the address they are limited as.');
  console.log('\nOne more check, by hand: run this again from a different network (a phone');
  console.log('on mobile data). Its first number should be near the full limit. If it');
  console.log('continues on from this run instead, every visitor shares one bucket —');
  console.log('the limiter is seeing the platform\'s address, not the visitor\'s.');
} else {
  console.log('FAIL: unset CLIENT_IP_HEADER (or lower TRUST_PROXY) and run this again.');
  process.exit(1);
}
