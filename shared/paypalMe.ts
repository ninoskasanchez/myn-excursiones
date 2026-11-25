const HANDLE = /^[a-z0-9]{1,20}$/i;
const PROFILE = /^https:\/\/(?:(?:www\.)?paypal\.me\/|(?:www\.)?paypal\.com\/paypalme\/)([a-z0-9]{1,20})\/?$/i;

/** Accept a handle or the profile URL copied from PayPal. Store only the handle. */
export const paypalMeHandle = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const input = value.trim();
  const handle = input.replace(/^@/, '');
  return HANDLE.test(handle) ? handle : PROFILE.exec(input)?.[1] ?? '';
};

/** PayPal.Me pre-fills the amount. The guest and operator still confirm the payment. */
export const paypalMePaymentUrl = (handle: string, amount: number | null): string => {
  if (!HANDLE.test(handle) || amount === null) return '';
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) return '';
  return `https://paypal.me/${handle}/${(cents / 100).toFixed(2)}USD`;
};
