import { Decimal as DecimalJs } from 'decimal.js';

// Input decimal strings have at most 80 characters. This covers their products
// and bounded accumulation without relying on decimal.js's 20-digit default.
export const Decimal = DecimalJs.clone({ precision: 200, rounding: DecimalJs.ROUND_HALF_UP });
export type Decimal = DecimalJs;
