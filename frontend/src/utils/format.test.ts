import { describe, expect, it } from 'vitest';
import { formatBalance } from './format';

describe('formatBalance', () => {
    it('formats normal positive and negative balances', () => {
        expect(formatBalance(120)).toBe('120.00');
        expect(formatBalance(-5.5)).toBe('-5.50');
        expect(formatBalance(0)).toBe('0.00');
    });

    it('treats tiny floating-point artifacts as zero', () => {
        expect(formatBalance(-1.2199999999999998e-7)).toBe('0.00');
        expect(formatBalance(1.22e-7)).toBe('0.00');
    });

    it('handles null, undefined and non-finite values', () => {
        expect(formatBalance(null)).toBe('0.00');
        expect(formatBalance(undefined)).toBe('0.00');
        expect(formatBalance(Number.NaN)).toBe('0.00');
    });
});
