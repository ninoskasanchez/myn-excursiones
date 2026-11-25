import { verifyAdminRequest } from '../../shared/adminAuth';
import { PaymentEnv } from '../../shared/paymentConfig';
import { BookingRequest } from '../../shared/bookingPrice';
import { startMioCheckout } from '../../shared/cardCheckout';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequest(context: { request: Request; env: PaymentEnv }) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Sandbox links are only created by the payment admin.
  const sandbox = new URL(request.url).searchParams.get('sandbox') === '1';
  if (sandbox) {
    const auth = await verifyAdminRequest(env as Parameters<typeof verifyAdminRequest>[0], request);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
  }
  let body: BookingRequest;
  try {
    body = (await request.json()) as BookingRequest;
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request body.' }, 400);
  if (sandbox) {
    body = { category: 'custom', title: 'MIO Sandbox', amount: 1, email: body.email, locale: 'es', returnPath: '/' };
  }
  const result = await startMioCheckout(env, request, body, sandbox ? 'test' : 'live');
  if (!result.ok) return json({ error: result.error, code: result.code }, result.status);
  if (result.kind !== 'redirect') return json({ error: 'Unexpected checkout.' }, 500);
  return json({ kind: 'redirect', url: result.url, ref: result.ref });
}
