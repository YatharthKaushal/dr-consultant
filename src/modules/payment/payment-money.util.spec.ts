import {
  MoneyFormatError,
  applyPctToPaise,
  basisPointsToPct,
  calculateBill,
  gatewayAmountToPaise,
  paiseToGatewayAmount,
  paiseToRupees,
  pctToBasisPoints,
  rupeesToPaise,
  sumRupees,
} from './payment-money.util';

describe('payment money arithmetic', () => {
  /* ------------------------------------------------------------------ */
  /* THE ACCEPTANCE CRITERION                                            */
  /* ------------------------------------------------------------------ */

  /**
   * `docs/SRS.md` FR-7.3 and `docs/MODULES.md` M-12's done-when ("the worked
   * example in the SRS reproduces exactly"). These five numbers are quoted
   * from the SRS verbatim; if this block ever fails, the module is not
   * shippable regardless of what else passes.
   */
  describe('FR-7.3 worked example — fee 500, convenience 20%, GST 18% => 708', () => {
    const bill = calculateBill('500.00', '20.00', '18.00');

    it('charges a convenience fee of exactly 100 rupees', () => {
      expect(bill.convenienceFeePaise).toBe(10_000n);
      expect(paiseToRupees(bill.convenienceFeePaise)).toBe('100.00');
    });

    it('reaches a subtotal of exactly 600 rupees', () => {
      expect(bill.subtotalPaise).toBe(60_000n);
      expect(paiseToRupees(bill.subtotalPaise)).toBe('600.00');
    });

    it('charges GST of exactly 108 rupees — 18% of the SUBTOTAL, not of the fee', () => {
      expect(bill.gstPaise).toBe(10_800n);
      expect(paiseToRupees(bill.gstPaise)).toBe('108.00');
      // The distinction the worked example exists to pin down: 18% of the fee
      // alone would be 90.00, and the bill would total 690, not 708.
      expect(paiseToRupees(applyPctToPaise(bill.consultationFeePaise, bill.gstBasisPoints))).toBe('90.00');
    });

    it('makes the patient payable exactly 708 rupees', () => {
      expect(bill.totalPayablePaise).toBe(70_800n);
      expect(paiseToRupees(bill.totalPayablePaise)).toBe('708.00');
    });

    it('sends 70800 integer paise to the gateway', () => {
      expect(paiseToGatewayAmount(bill.totalPayablePaise)).toBe(70_800);
    });

    /**
     * FR-7.4: "the doctor payout view for the same consultation shows
     * consultation fee 500 rupees, platform deduction 0 rupees, doctor earning
     * 500 rupees." There is no arithmetic to it — the payout IS the stored
     * consultation fee, untouched by the convenience fee or GST, which is the
     * whole point of the transparent-billing model.
     */
    it('FR-7.4: the doctor earns the full 500 with a zero platform deduction', () => {
      const doctorEarningPaise = bill.consultationFeePaise;
      const platformDeductionPaise = bill.consultationFeePaise - doctorEarningPaise;

      expect(paiseToRupees(doctorEarningPaise)).toBe('500.00');
      expect(paiseToRupees(platformDeductionPaise)).toBe('0.00');
      // Neither the convenience fee nor the GST comes out of the doctor's fee.
      expect(doctorEarningPaise).toBe(rupeesToPaise('500.00'));
    });

    it('the components sum to the total, with no stored total column to disagree with them', () => {
      expect(bill.consultationFeePaise + bill.convenienceFeePaise + bill.gstPaise).toBe(bill.totalPayablePaise);
    });
  });

  /* ------------------------------------------------------------------ */
  /* ROUNDING                                                            */
  /* ------------------------------------------------------------------ */

  describe('rounding', () => {
    /**
     * A fee with odd paise, chosen because 20% of it lands exactly on a half
     * paise (6666.6 -> 6667) and the rounded convenience fee then makes the
     * subtotal a round 400.00. Proves the rounded component feeds the next
     * step rather than the unrounded one.
     */
    it('rounds a fee of 333.33 half-up at each component', () => {
      const bill = calculateBill('333.33', '20.00', '18.00');

      // 33333 x 20% = 6666.6 paise -> 6667 half-up.
      expect(paiseToRupees(bill.convenienceFeePaise)).toBe('66.67');
      // 33333 + 6667 = 40000 paise. The ROUNDED convenience fee is what forms it.
      expect(paiseToRupees(bill.subtotalPaise)).toBe('400.00');
      expect(paiseToRupees(bill.gstPaise)).toBe('72.00');
      expect(paiseToRupees(bill.totalPayablePaise)).toBe('472.00');
      expect(bill.consultationFeePaise + bill.convenienceFeePaise + bill.gstPaise).toBe(bill.totalPayablePaise);
    });

    it('rounds exactly half a paise UP, not to even', () => {
      // 2.50 paise -> 3. Banker's rounding would give 2, which is the bug this
      // assertion exists to catch.
      expect(applyPctToPaise(50n, 500n)).toBe(3n);
      // 1.50 paise -> 2 (banker's rounding would also give 2 here, so the
      // case above is the discriminating one).
      expect(applyPctToPaise(30n, 500n)).toBe(2n);
    });

    it('rounds below the halfway point down', () => {
      // 33333 x 10% = 3333.3 paise -> 3333.
      expect(applyPctToPaise(33_333n, 1_000n)).toBe(3_333n);
    });

    it('rounds above the halfway point up', () => {
      // 33333 x 18% = 5999.94 paise -> 6000.
      expect(applyPctToPaise(33_333n, 1_800n)).toBe(6_000n);
    });

    it('handles a fractional rate — numeric(5,2) allows 18.50%', () => {
      const bill = calculateBill('500.00', '20.00', '18.50');
      // 60000 x 18.5% = 11100 paise exactly.
      expect(paiseToRupees(bill.gstPaise)).toBe('111.00');
      expect(paiseToRupees(bill.totalPayablePaise)).toBe('711.00');
    });

    it('never loses a paise to floating point on a fee that has no exact binary representation', () => {
      // 0.1 + 0.2 !== 0.3 in IEEE-754. In paise this is exact.
      const bill = calculateBill('0.10', '20.00', '18.00');
      expect(bill.consultationFeePaise).toBe(10n);
      // 10 x 20% = 2 paise. 12 x 18% = 2.16 -> 2 paise.
      expect(bill.convenienceFeePaise).toBe(2n);
      expect(bill.subtotalPaise).toBe(12n);
      expect(bill.gstPaise).toBe(2n);
      expect(paiseToRupees(bill.totalPayablePaise)).toBe('0.14');
    });

    it('is exact at the top of numeric(10,2)', () => {
      const bill = calculateBill('99999999.99', '20.00', '18.00');
      expect(bill.consultationFeePaise).toBe(9_999_999_999n);
      // 9999999999 x 20% = 1999999999.8 -> 2000000000 half-up.
      expect(bill.convenienceFeePaise).toBe(2_000_000_000n);
      expect(bill.subtotalPaise).toBe(11_999_999_999n);
      // Still well inside the safe-integer range a JSON body can carry.
      expect(() => paiseToGatewayAmount(bill.totalPayablePaise)).not.toThrow();
    });

    it('produces a zero bill for a zero fee rather than throwing', () => {
      const bill = calculateBill('0.00', '20.00', '18.00');
      expect(bill.totalPayablePaise).toBe(0n);
      expect(paiseToRupees(bill.totalPayablePaise)).toBe('0.00');
    });

    it('charges nothing extra when both rates are zero', () => {
      const bill = calculateBill('500.00', '0.00', '0.00');
      expect(paiseToRupees(bill.totalPayablePaise)).toBe('500.00');
      expect(bill.convenienceFeePaise).toBe(0n);
      expect(bill.gstPaise).toBe(0n);
    });
  });

  /* ------------------------------------------------------------------ */
  /* PARSING AND FORMATTING                                              */
  /* ------------------------------------------------------------------ */

  describe('rupeesToPaise', () => {
    it.each([
      ['500', 50_000n],
      ['500.00', 50_000n],
      // "500.5" is FIFTY paise, not five — the fractional part is padded, not parsed as an integer.
      ['500.5', 50_050n],
      ['500.05', 50_005n],
      ['0', 0n],
      ['0.00', 0n],
      ['0.01', 1n],
      ['99999999.99', 9_999_999_999n],
    ])('parses %s to %s paise', (input, expected) => {
      expect(rupeesToPaise(input)).toBe(expected);
    });

    it.each([
      // A third decimal place is REFUSED, not truncated — silently dropping it
      // is how a rounding bug gets into a bill.
      ['500.005'],
      ['-1.00'],
      ['1e3'],
      ['500.'],
      ['.50'],
      [''],
      ['500 '],
      [' 500'],
      ['₹500'],
      ['500,00'],
      ['NaN'],
      ['Infinity'],
      ['999999999.99'],
    ])('rejects %s', (input) => {
      expect(() => rupeesToPaise(input)).toThrow(MoneyFormatError);
    });

    it('rejects a number, because a numeric column arrives as a string and a number has already lost precision', () => {
      expect(() => rupeesToPaise(500 as unknown as string)).toThrow(MoneyFormatError);
    });
  });

  describe('paiseToRupees', () => {
    it.each([
      [50_000n, '500.00'],
      [50_050n, '500.50'],
      [1n, '0.01'],
      [0n, '0.00'],
      [9_999_999_999n, '99999999.99'],
    ])('formats %s paise as %s', (input, expected) => {
      expect(paiseToRupees(input)).toBe(expected);
    });

    it('round-trips through rupeesToPaise unchanged', () => {
      for (const paise of [0n, 1n, 99n, 100n, 50_000n, 70_800n, 9_999_999_999n]) {
        expect(rupeesToPaise(paiseToRupees(paise))).toBe(paise);
      }
    });

    it('refuses a negative amount', () => {
      expect(() => paiseToRupees(-1n)).toThrow(MoneyFormatError);
    });
  });

  describe('pctToBasisPoints / basisPointsToPct', () => {
    it.each([
      ['20', 2_000n],
      ['20.00', 2_000n],
      ['18.00', 1_800n],
      ['18.5', 1_850n],
      ['18.50', 1_850n],
      ['0.01', 1n],
      ['0.00', 0n],
      ['999.99', 99_999n],
    ])('parses %s%% to %s basis points', (input, expected) => {
      expect(pctToBasisPoints(input)).toBe(expected);
    });

    it.each([['-1'], ['20.005'], ['1000.00'], [''], ['20%'], ['abc']])('rejects %s', (input) => {
      expect(() => pctToBasisPoints(input)).toThrow(MoneyFormatError);
    });

    it('formats basis points back to a numeric(5,2)-shaped string', () => {
      expect(basisPointsToPct(2_000n)).toBe('20.00');
      expect(basisPointsToPct(1_850n)).toBe('18.50');
      expect(basisPointsToPct(1n)).toBe('0.01');
      expect(basisPointsToPct(0n)).toBe('0.00');
    });

    it('round-trips, so the rate snapshotted onto the payment equals the rate that was applied', () => {
      for (const pct of ['0.00', '18.00', '18.50', '20.00', '999.99']) {
        expect(basisPointsToPct(pctToBasisPoints(pct))).toBe(pct);
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* THE GATEWAY BOUNDARY                                                */
  /* ------------------------------------------------------------------ */

  describe('gateway amount conversion', () => {
    it('converts paise to the integer Razorpay expects', () => {
      expect(paiseToGatewayAmount(70_800n)).toBe(70_800);
      expect(paiseToGatewayAmount(0n)).toBe(0);
    });

    it('refuses an amount too large to survive JSON as a safe integer', () => {
      expect(() => paiseToGatewayAmount(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(MoneyFormatError);
    });

    it('reads a gateway integer back into paise', () => {
      expect(gatewayAmountToPaise(70_800)).toBe(70_800n);
      expect(gatewayAmountToPaise(0)).toBe(0n);
    });

    it.each([[70_800.5], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['70800'], [null], [undefined]])(
      'refuses %s from the gateway rather than truncating it',
      (input) => {
        expect(() => gatewayAmountToPaise(input)).toThrow(MoneyFormatError);
      },
    );
  });

  describe('sumRupees', () => {
    it('sums exactly, in paise', () => {
      // 0.1 + 0.2 in floating point is 0.30000000000000004.
      expect(sumRupees(['0.10', '0.20'])).toBe(30n);
      expect(paiseToRupees(sumRupees(['100.50', '200.25', '0.25']))).toBe('301.00');
    });

    it('sums an empty list to zero', () => {
      expect(sumRupees([])).toBe(0n);
    });

    it('propagates a malformed entry rather than skipping it', () => {
      expect(() => sumRupees(['100.00', 'oops'])).toThrow(MoneyFormatError);
    });
  });
});
