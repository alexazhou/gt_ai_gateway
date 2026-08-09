import { describe, expect, it } from 'vitest';
import { formatBalance } from './format';

describe('formatBalance', () => {
    it('formats normal positive and negative balances', () => {
        expect(formatBalance(120)).toBe('120.00');
        expect(formatBalance(-5.5)).toBe('-5.50');
        expect(formatBalance(0)).toBe('0.00');
    });

    it('treats tiny positive balances as zero', () => {
        expect(formatBalance(1.22e-7)).toBe('0.00');
        expect(formatBalance(0.000001)).toBe('0.00');
    });

    it('shows tiny negative balances (debts) honestly instead of 0.00', () => {
        // 微元粒度余额：-0.000001 元（-1 微元）等欠费必须如实显示
        expect(formatBalance(-0.000001)).toBe('-0.000001');
        expect(formatBalance(-0.000014)).toBe('-0.000014');
    });

    it('handles null, undefined and non-finite values', () => {
        expect(formatBalance(null)).toBe('0.00');
        expect(formatBalance(undefined)).toBe('0.00');
        expect(formatBalance(Number.NaN)).toBe('0.00');
    });
});
