import { twMerge } from 'tailwind-merge';

import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A stored payment amount for display: 7.00, or 2.0081 when it carries a USDT
 * tag. The column holds four decimals for the tag's sake, and the last digits
 * of a tagged amount must never be rounded away.
 */
export function formatAmount(value: string | number | undefined): string {
  if (value === undefined) return '';
  const amount = Number(value);
  const exact = amount.toFixed(4);
  return exact.endsWith('00') ? amount.toFixed(2) : exact;
}
