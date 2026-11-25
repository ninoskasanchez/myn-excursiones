import { isOrderId, ORDER_TTL_SECONDS, plainText, readOrder, saveOrder } from './bankGateways';
import type { PaymentOrder } from './bankGateways';
import { kvOf, mioV5Settings, readPaymentSecrets } from './paymentConfig';
import type { GatewayMode, LocalCurrency, PaymentEnv, PaymentSecrets } from './paymentConfig';
import { reasonFromIso } from './paymentOutcome';

const MIO_API: Record<GatewayMode, string> = {
  test: 'https://mionegocios.com.do/gatewayv1sandbox/api',
  live: 'https://mionegocios.com.do/gatewayv1/api',
};

const TOKEN_PREFIX = 'mio-v5:token:';
const WEBHOOK_PREFIX = 'mio-v5:webhook:';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const mioEmail = (value: unknown): string | null => {
  const email = typeof value === 'string' ? value.trim() : '';
  return email.length <= 200 && EMAIL.test(email) ? email : null;
};

export const isMioToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 250 && /^[!-~]+$/.test(value);

async function tokenKey(token: string, prefix: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return prefix + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type MioReply = { success?: boolean; data?: unknown };

async function postMio(
  mode: GatewayMode,
  apiKey: string,
  endpoint: 'UrlPayment' | 'ResultTransactionByTokenId',
  payload: Record<string, unknown>
): Promise<MioReply | null> {
  try {
    const response = await fetch(`${MIO_API[mode]}/${endpoint}`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const body: MioReply | null = response.ok ? await response.json() : null;
    if (body?.success !== true) {
      console.warn('[mio-v5] request unsuccessful', mode, endpoint, response.status);
      return null;
    }
    return body;
  } catch {
    console.warn('[mio-v5] request failed', mode, endpoint);
    return null;
  }
}

export async function createMioV5Link(
  env: PaymentEnv,
  secrets: PaymentSecrets,
  order: PaymentOrder,
  clientIp: string,
  email: string
): Promise<{ url: string } | null> {
  const kv = kvOf(env);
  if (!kv || !order.mioV5) return null;
  const { mode } = order.mioV5;
  const { apiKey } = mioV5Settings(secrets, mode);
  const description = plainText(order.booking.title, 100) || 'Reserva';
  const reply = await postMio(mode, apiKey, 'UrlPayment', {
    totalamount: order.amount,
    reference: order.id,
    email,
    clientip: clientIp,
    transactiontype: '999',
    sendmail: '0',
    additionalinfo: [{ name: 'Reserva', description, amount: order.amount, quantity: 1 }],
  });

  const data = reply?.data as { UrlPayment?: unknown; Tokenid?: unknown } | undefined;
  if (!data || !isMioToken(data.Tokenid) || typeof data.UrlPayment !== 'string' || data.UrlPayment.length > 500) return null;

  let url: URL;
  try {
    url = new URL(data.UrlPayment);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;

  order.session = data.Tokenid;
  order.approveUrl = url.href;
  if (!(await saveOrder(env, order))) return null;
  try {
    await kv.put(await tokenKey(data.Tokenid, `${TOKEN_PREFIX}${mode}:`), order.id, { expirationTtl: ORDER_TTL_SECONDS });
  } catch {
    console.warn('[mio-v5] could not index checkout', order.id);
    return null;
  }
  return { url: url.href };
}

export async function readMioV5Order(env: PaymentEnv, mode: GatewayMode, token: string): Promise<PaymentOrder | null> {
  const kv = kvOf(env);
  if (!kv) return null;
  const ref = await kv.get(await tokenKey(token, `${TOKEN_PREFIX}${mode}:`));
  if (typeof ref !== 'string' || !isOrderId(ref)) return null;
  const order = await readOrder(env, ref);
  return order?.provider === 'mio' && order.mioV5?.mode === mode && order.session === token ? order : null;
}

function amountInCents(value: unknown): number | null {
  const amount = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const match = /^(\d{1,14})(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function readCurrency(value: unknown): LocalCurrency | null {
  if (typeof value !== 'string') return null;
  const currency = plainText(value, 50).toUpperCase();
  if (/^(DOP|RD\$|PESOS?( DOMINICANOS?)?)$/.test(currency)) return 'DOP';
  if (/^(USD|US\$|DOLARES?( (AMERICANOS?|ESTADOUNIDENSES?))?)$/.test(currency)) return 'USD';
  return null;
}

type MioTransaction = {
  Tokenid?: string;
  ReferenceOrig?: string;
  ReferenceCode?: string;
  ProcessCode?: string;
  ResultCode?: string;
  TotalAmount?: number | string;
  DescriptionCurrency?: string;
  ApprovedCode?: string;
};

/** Persist a verdict obtained directly from MIO. Redirects and webhooks just locate the order. */
export async function settleMioV5(
  env: PaymentEnv,
  secrets: PaymentSecrets,
  order: PaymentOrder
): Promise<'settled' | 'pending' | 'retry' | 'review'> {
  if (!order.mioV5 || !order.session) return 'retry';
  if (order.status === 'paid') return 'settled';
  const { mode } = order.mioV5;
  const { apiKey } = mioV5Settings(secrets, mode);
  if (!apiKey) return 'retry';

  const reply = await postMio(mode, apiKey, 'ResultTransactionByTokenId', { Tokenid: [order.session] });
  if (!reply || !Array.isArray(reply.data)) return 'retry';
  const results = (reply.data as MioTransaction[]).filter((entry) => entry?.Tokenid === order.session);
  if (!results.length) return 'pending';

  const approved = results.find((entry) => entry.ResultCode === '00');
  const result = approved ?? results[results.length - 1];
  if (result.ReferenceOrig !== order.id || (approved && (
    amountInCents(approved.TotalAmount) !== order.amountMinor || readCurrency(approved.DescriptionCurrency) !== order.currency
  ))) {
    console.warn('[mio-v5] payment details differ from saved order', order.id);
    return 'review';
  }
  if (typeof result.ResultCode !== 'string' || result.ResultCode === '') return 'pending';
  if (!approved && order.status === 'declined' && order.code === result.ResultCode) return 'settled';

  const declineReason = reasonFromIso(result.ResultCode);
  const next: PaymentOrder = {
    ...order,
    status: approved ? 'paid' : 'declined',
    reason: approved ? 'approved' : declineReason === 'approved' ? 'declined' : declineReason,
    code: result.ResultCode,
    reference: result.ReferenceCode ?? result.ProcessCode,
    authorizationCode: approved?.ApprovedCode,
    updatedAt: new Date().toISOString(),
  };
  if (!(await saveOrder(env, next))) return 'retry';
  Object.assign(order, next);
  return 'settled';
}


type Notification = { token: string; mode: GatewayMode };

export async function queueMioNotification(env: PaymentEnv, notice: Notification): Promise<string | null> {
  const kv = kvOf(env);
  if (!kv?.list || !kv.delete) return null;
  const key = await tokenKey(notice.token, `${WEBHOOK_PREFIX}${notice.mode}:`);
  try {
    await kv.put(key, JSON.stringify(notice), { expirationTtl: 60 * 60 * 24 * 3 });
    return key;
  } catch {
    // Cloudflare KV may throttle repeated writes to the same key.
    return await kv.get(key).catch(() => null) ? key : null;
  }
}

export async function processMioNotification(
  env: PaymentEnv, secrets: PaymentSecrets, key: string, notice: Notification
): Promise<void> {
  const order = await readMioV5Order(env, notice.mode, notice.token);
  if (!order?.mioV5) return;
  const result = await settleMioV5(env, secrets, order);
  if (result === 'settled' || result === 'review') await kvOf(env)?.delete?.(key);
}

export async function sweepMioNotifications(env: PaymentEnv): Promise<void> {
  const kv = kvOf(env);
  if (!kv?.list || !kv.delete) return;
  const secrets = await readPaymentSecrets(env);
  if (!secrets.mioV5LiveApiKey && !secrets.mioV5TestApiKey) return;
  const { keys } = await kv.list({ prefix: WEBHOOK_PREFIX, limit: 20 });
  await Promise.all(keys.map(async ({ name }) => {
    const notice: Notification | null = await kv.get(name, { type: 'json' });
    if (notice && (notice.mode === 'test' || notice.mode === 'live') && isMioToken(notice.token)) await processMioNotification(env, secrets, name, notice);
  }));
}
