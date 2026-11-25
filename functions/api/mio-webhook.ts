import { readPaymentSecrets, mioV5Settings } from '../../shared/paymentConfig';
import type { GatewayMode, PaymentEnv } from '../../shared/paymentConfig';
import { readOrder, saveOrder } from '../../shared/bankGateways';
import { refreshOrder } from '../../shared/paymentSettle';
import { isMioToken, readMioV5Order, queueMioNotification, processMioNotification, settleMioV5 } from '../../shared/mioV5';

function matchesKey(expected: string, supplied: string): boolean {
  if (!expected || expected.length !== supplied.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return mismatch === 0;
}

const ack = () => new Response('EVENT_RECEIVED', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const retry = () => new Response(null, { status: 503, headers: { 'Retry-After': '10' } });

export async function onRequest({
  request, env, waitUntil,
}: { request: Request; env: PaymentEnv; waitUntil?: (promise: Promise<unknown>) => void }) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

  const url = new URL(request.url);
  const legacyRef = url.searchParams.get('order');
  if (legacyRef) {
    // Geopagos supplied the order in each callback URL. Only historical orders use it.
    const order = await readOrder(env, legacyRef);
    if (order?.provider === 'mio' && !order.mioV5 && await refreshOrder(env, order)) {
      order.updatedAt = new Date().toISOString();
      await saveOrder(env, order);
    }
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const secrets = await readPaymentSecrets(env);
  const mode = url.searchParams.get('mode') ?? 'live';
  if (mode !== 'live' && mode !== 'test') return new Response(null, { status: 400 });
  const expected = mioV5Settings(secrets, mode).globalKey;
  if (!matchesKey(expected, request.headers.get('Global-KEY') ?? '')) return new Response(null, { status: 401 });

  const body = await request.json().catch(() => null) as { Tokenid?: unknown } | null;
  if (!body || !isMioToken(body.Tokenid)) return new Response(null, { status: 400 });
  const order = await readMioV5Order(env, mode, body.Tokenid).catch(() => null);
  if (order?.status === 'paid') return ack();

  if (waitUntil) {
    // Record the notification before acknowledging it. A lookup can fail or
    // arrive before the token index has reached this region.
    const notice = { token: body.Tokenid, mode: mode as GatewayMode };
    const key = await queueMioNotification(env, notice);
    if (key) {
      waitUntil(processMioNotification(env, secrets, key, notice).catch(() => console.warn('[mio-v5] confirmation queued for retry')));
      return ack();
    }
  }

  if (!order?.mioV5) return retry();
  const result = await settleMioV5(env, secrets, order);
  return result === 'retry' || result === 'pending' ? retry() : ack();
}
