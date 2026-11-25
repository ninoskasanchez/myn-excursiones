import { guestLanding } from '../../shared/bankGateways';
import { isMioToken, readMioV5Order } from '../../shared/mioV5';
import type { PaymentEnv } from '../../shared/paymentConfig';

export async function onRequest({ request, env }: { request: Request; env: PaymentEnv }) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
  const params = new URL(request.url).searchParams;
  const mode = params.get('mode') ?? 'live';
  const token = params.get('token');
  if ((mode !== 'live' && mode !== 'test') || !isMioToken(token)) {
    return new Response('MIO no incluyó la referencia del pago. Si se hizo un cobro, guarda el comprobante y contáctanos.', { status: 400, headers });
  }
  const order = await readMioV5Order(env, mode, token).catch(() => null);
  if (!order) {
    return new Response('Aún no pudimos localizar el pago de MIO. Recarga en un momento. Si se hizo un cobro, guarda el comprobante y contáctanos.', {
      status: 503, headers: { ...headers, 'Retry-After': '10' },
    });
  }
  // The receipt performs the authenticated lookup and shows the resulting status.
  return new Response(null, { status: 303, headers: { ...headers, Location: guestLanding(order) } });
}
