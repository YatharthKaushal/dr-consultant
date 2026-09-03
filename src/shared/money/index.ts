/**
 * The money arithmetic every module shares.
 *
 * `money.util.ts` holds the primitives — rupee/paise conversion, basis points,
 * half-up percentage application, and the gateway boundary. `money-allocate.
 * util.ts` holds the splitting operations a multi-line bill needs: backing tax
 * out of an inclusive price, halving a tax into CGST/SGST, and apportioning an
 * amount across lines without losing a paise.
 *
 * Read `money.util.ts`'s header before changing any of it: integer paise as
 * `bigint`, integer basis points, round once per component, and nothing here
 * touches config, a row or the clock.
 */
export {
  BASIS_POINTS_PER_100_PERCENT,
  MoneyFormatError,
  applyPctToPaise,
  basisPointsToPct,
  gatewayAmountToPaise,
  paiseToGatewayAmount,
  paiseToRupees,
  pctToBasisPoints,
  rupeesToPaise,
  sumRupees,
} from './money.util';

export { allocateLargestRemainder, halveHalfUp, inclusiveTaxableValue } from './money-allocate.util';
