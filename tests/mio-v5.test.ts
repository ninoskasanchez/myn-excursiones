import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { onRequest as checkout } from '../functions/api/mio-checkout';
import { onRequest as cardCheckout } from '../functions/api/card-checkout';
import { onRequest as webhook } from '../functions/api/mio-webhook';
import { onRequest as returnPayment } from '../functions/api/mio-return';
import { onRequest as paymentResult } from '../functions/api/payment-result';
import { onRequest as ready } from '../functions/api/payments-ready';
import { onRequest as config } from '../functions/api/payment-config';
import { onRequest as retry } from '../functions/api/pay-retry';
import { readOrder, saveOrder } from '../shared/bankGateways';
import type { PaymentOrder } from '../shared/bankGateways';
import { sweepMioNotifications } from '../shared/mioV5';

const page = 'https://myn-excursiones.example';
const token = 'SAME_TOKEN_ACROSS_ENVIRONMENTS';
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

function fixture(paymentSettings: Record<string, unknown> = {}) {
  const memory = new Map<string, string>();
  const settings = {
    mioMode: 'live', mioMerchantId: '123', mioClientId: 'legacy-client',
    mioClientSecret: 'legacy-secret', mioAuthUrl: 'https://legacy.example/oauth/token',
    mioApiBase: 'https://legacy.example', mioV5Mode: 'live',
    mioV5LiveApiKey: 'live-api', mioV5LiveGlobalKey: 'live-global', mioV5LiveCurrency: 'DOP',
    mioV5TestApiKey: 'sandbox-api', mioV5TestGlobalKey: 'sandbox-global', mioV5TestCurrency: 'USD',
    dopPerUsd: 60.5, cardProcessor: 'mio', ...paymentSettings,
  };
  memory.set('payment-secrets', JSON.stringify(settings));
  memory.set('admin-password', 'operator');
  memory.set('tours-en', JSON.stringify([{ id: 7, title: 'Saona', price: 20.25 }]));
  const env = {
    DATA_KV_F: {
      async get(key: string, options?: { type: 'json' }) {
        const value = memory.get(key) ?? null;
        return options?.type === 'json' && value !== null ? JSON.parse(value) : value;
      },
      async put(key: string, value: string) { memory.set(key, value); },
      async delete(key: string) { memory.delete(key); },
      async list({ prefix, limit }: { prefix: string; limit: number }) {
        return { keys: [...memory.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit).map((name) => ({ name })) };
      },
    },
  };

  type Call = { path: string; key: string | null; body: Record<string, any> };
  const calls: Call[] = [];
  let rows: unknown[] | null = [];
  let redirect = 'https://mionegocios.com.do/PaymentGateway?token=' + token;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === 'legacy.example') {
      if (url.pathname === '/oauth/token') return Response.json({ access_token: 'legacy' });
      return Response.json({ payments: [{ status: 'APPROVED', reference_number: 'legacy-confirmation' }] });
    }
    assert.equal(url.origin, 'https://mionegocios.com.do');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const key = new Headers(init?.headers).get('X-API-KEY');
    const body = JSON.parse(String(init?.body));
    calls.push({ path: url.pathname, key, body });
    if (url.pathname.endsWith('/UrlPayment')) {
      return Response.json({ success: true, data: { UrlPayment: redirect, Tokenid: token } });
    }
    assert.ok(url.pathname.endsWith('/ResultTransactionByTokenId'));
    assert.deepEqual(body, { Tokenid: [token] });
    return rows === null ? Response.json({}, { status: 503 }) : Response.json({ success: true, data: rows });
  };

  const req = (route: string, body?: unknown, headers?: Record<string, string>) => new Request(page + route, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.12', ...headers },
  });
  const start = (email = 'guest@example.org') => checkout({
    request: req('/api/mio-checkout', { category: 'tours', title: 'Saona', serviceId: 7, persons: 2, amount: 1, email }),
    env,
  });
  const lookup = async (ref: string) => (await paymentResult({ request: req('/api/payment-result?ref=' + ref), env })).json();
  const event = (key = 'live-global', mode = 'live', waitUntil?: (promise: Promise<unknown>) => void) => webhook({
    request: req('/api/mio-webhook?mode=' + mode, { Tokenid: token, ResultCode: '00', TotalAmount: 0.01 }, { 'Global-KEY': key }), env, waitUntil,
  });
  const row = (ref: string, overrides: Record<string, unknown> = {}) => ({
    ReferenceOrig: ref, Tokenid: token, ResultCode: '00',
    TotalAmount: '2450.25', DescriptionCurrency: 'Pesos', ApprovedCode: 'ABC123', ...overrides,
  });
  return { env, calls, req, start, lookup, event, row, setRows: (value: unknown[] | null) => { rows = value; }, setRedirect: (value: string) => { redirect = value; } };
}

test('creates a server-priced UrlPayment with the required fields, then returns to the booking receipt', async () => {
  const f = fixture();
  const response = await f.start();
  assert.equal(response.status, 200);
  const { ref, url } = await response.json();
  assert.match(ref, /^[1-9]\d{14}$/);
  assert.match(url, /^https:\/\/mionegocios\.com\.do\//);
  assert.deepEqual(f.calls[0], {
    path: '/gatewayv1/api/UrlPayment', key: 'live-api',
    body: {
      totalamount: 2450.25, reference: ref, email: 'guest@example.org', clientip: '203.0.113.12',
      transactiontype: '999', sendmail: '0',
      additionalinfo: [{ name: 'Reserva', description: 'Saona', amount: 2450.25, quantity: 1 }],
    },
  });
  const back = await returnPayment({ request: f.req('/api/mio-return?token=' + token), env: f.env });
  assert.equal(back.status, 303);
  assert.match(back.headers.get('Location') ?? '', new RegExp('payment_ref=' + ref));
  assert.equal((await f.lookup(ref)).status, 'pending');
});

test('rejects invalid email, unsafe checkout URL, and missing public credentials', async () => {
  const f = fixture();
  assert.equal((await f.start('bad')).status, 400);
  assert.equal(f.calls.length, 0);
  f.setRedirect('javascript:alert(1)');
  assert.equal((await f.start()).status, 502);
  const disabled = fixture({ mioV5LiveApiKey: '', mioV5LiveGlobalKey: '' });
  const readiness = await ready({ request: disabled.req('/api/payments-ready'), env: disabled.env });
  assert.equal((await readiness.json()).mio, false);
  assert.equal((await disabled.start()).status, 503);
  assert.equal(disabled.calls.length, 0);
});

test('verifies identity, amount, and currency with MIO, ignoring browser and webhook approval hints', async () => {
  const f = fixture();
  const { ref } = await (await f.start()).json();
  assert.equal((await f.event('invalid')).status, 401);
  assert.equal(f.calls.length, 1);
  for (const overrides of [
    { ReferenceOrig: '111111111111111' }, { Tokenid: 'another' },
    { TotalAmount: 2450.251 }, { TotalAmount: 2450.24 }, { DescriptionCurrency: 'USD' },
  ]) {
    f.setRows([f.row(ref, overrides)]);
    const result = await f.lookup(ref);
    assert.notEqual(result.status, 'paid');
    assert.equal(result.paid, false);
  }
  f.setRows([f.row(ref)]);
  const first = await f.event();
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'EVENT_RECEIVED');
  const count = f.calls.length;
  assert.equal(await (await f.event()).text(), 'EVENT_RECEIVED');
  const result = await f.lookup(ref);
  assert.equal(result.paid, true);
  assert.equal(result.authorizationCode, 'ABC123');
  assert.equal(f.calls.length, count);
});

test('accepts a webhook without a browser, retries a delayed lookup, and never lets a late decline overwrite a paid order', async () => {
  const f = fixture();
  const { ref } = await (await f.start()).json();
  const old = (await readOrder(f.env, ref)) as PaymentOrder;
  const background: Promise<unknown>[] = [];
  f.setRows(null);
  const response = await f.event('live-global', 'live', (promise) => { background.push(promise); });
  assert.equal(await response.text(), 'EVENT_RECEIVED');
  await Promise.all(background);
  assert.equal((await readOrder(f.env, ref))?.status, 'pending');
  f.setRows([f.row(ref)]);
  await sweepMioNotifications(f.env);
  await saveOrder(f.env, { ...old, status: 'declined', code: '05' });
  assert.equal((await readOrder(f.env, ref))?.status, 'paid');
  assert.equal((await retry({ request: f.req('/api/pay-retry', { ref }), env: f.env })).status, 409);
});

test('sandbox is authenticated, isolated from live tokens, and never advertised to guests', async () => {
  const f = fixture({ mioV5Mode: 'test' });
  assert.equal((await f.start()).status, 503);
  const status = await ready({ request: f.req('/api/payments-ready'), env: f.env });
  assert.equal((await status.json()).card, false);

  const sandbox = '/api/mio-checkout?sandbox=1';
  assert.equal((await checkout({ request: f.req(sandbox, { email: 'guest@example.org' }), env: f.env })).status, 401);
  const request = f.req(sandbox, { email: 'guest@example.org', amount: 500 }, { 'X-Admin-Password': 'operator' });
  const { ref } = await (await checkout({ request, env: f.env })).json();
  assert.equal(f.calls[0].path, '/gatewayv1sandbox/api/UrlPayment');
  assert.equal(f.calls[0].key, 'sandbox-api');
  assert.equal(f.calls[0].body.totalamount, 1);
  assert.equal((await f.event('live-global', 'test')).status, 401);
  assert.equal((await returnPayment({ request: f.req('/api/mio-return?token=' + token), env: f.env })).status, 503);
  f.setRows([f.row(ref, { TotalAmount: 1, DescriptionCurrency: 'Dólares' })]);
  assert.equal(await (await f.event('sandbox-global', 'test')).text(), 'EVENT_RECEIVED');
  assert.equal((await f.lookup(ref)).sandbox, true);
  assert.equal((await f.lookup(ref)).status, 'paid');
});

test('settles declines, reuses the original checkout on retry, and supports the generic card entry point', async () => {
  const f = fixture();
  const request = f.req('/api/card-checkout', { category: 'tours', title: 'Saona', persons: 2, email: 'guest@example.org' });
  const { orderRef, url } = await (await cardCheckout({ request, env: f.env })).json();
  f.setRows([f.row(orderRef, { ResultCode: '33' })]);
  const receipt = await f.lookup(orderRef);
  assert.equal(receipt.method, 'card');
  assert.equal(receipt.status, 'declined');
  assert.equal(receipt.reason, 'expired_card');
  const again = await retry({ request: f.req('/api/pay-retry', { ref: orderRef }), env: f.env });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).url, url);
  assert.equal(f.calls.filter(({ path }) => path.endsWith('/UrlPayment')).length, 1);
});

test('retains legacy confirmation and never exposes MIO keys in admin configuration', async () => {
  const f = fixture();
  const { ref } = await (await f.start()).json();
  const old = (await readOrder(f.env, ref)) as PaymentOrder;
  await saveOrder(f.env, { ...old, id: '111111111111111', session: 'old-link', mioV5: undefined });
  assert.equal((await f.lookup('111111111111111')).reference, 'legacy-confirmation');

  const response = await config({ request: f.req('/api/payment-config', undefined, { 'X-Admin-Password': 'operator' }), env: f.env });
  assert.equal(response.status, 200);
  const payload = await response.text();
  assert.ok(!/live-api|live-global|sandbox-api|sandbox-global|legacy-secret/.test(payload));
  assert.equal(JSON.parse(payload).mio.live.apiKeyConfigured, true);
});
