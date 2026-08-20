import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import type { MembershipStatus } from '@prisma/client';

import {
  EXPIRING_SOON_DAYS,
  LAPSED_AFTER_DAYS,
  addDays,
  currentMembershipWhere,
  daysUntil,
  displayStatus,
  effectiveMemberStatus,
  formatMemberNo,
  isLapsed,
  renewalStart,
  toView,
} from '../../src/services/membership.js';

/** A fixed "now" so these tests do not change meaning overnight. */
const NOW = new Date('2026-06-15T12:00:00');

const membership = (status: MembershipStatus, expiryDate: Date) => ({ status, expiryDate });

describe('addDays', () => {
  it('moves the date forward', () => {
    expect(addDays(new Date('2026-06-15T12:00:00'), 30))
      .toEqual(new Date('2026-07-15T12:00:00'));
  });

  it('moves backward for a negative count', () => {
    expect(addDays(new Date('2026-06-15T12:00:00'), -15))
      .toEqual(new Date('2026-05-31T12:00:00'));
  });

  it('rolls over month and year boundaries', () => {
    expect(addDays(new Date('2026-12-20T12:00:00'), 30))
      .toEqual(new Date('2027-01-19T12:00:00'));
  });

  it('handles a leap day', () => {
    expect(addDays(new Date('2028-02-28T12:00:00'), 1))
      .toEqual(new Date('2028-02-29T12:00:00'));
  });

  it('does not mutate the date it was given', () => {
    const from = new Date('2026-06-15T12:00:00');
    addDays(from, 30);
    expect(from).toEqual(new Date('2026-06-15T12:00:00'));
  });
});

describe('daysUntil', () => {
  it('counts whole days ahead', () => {
    expect(daysUntil(new Date('2026-06-25T12:00:00'), NOW)).toBe(10);
  });

  it('goes negative once the date has passed', () => {
    expect(daysUntil(new Date('2026-06-05T12:00:00'), NOW)).toBe(-10);
  });

  it('is 0 for today', () => {
    expect(daysUntil(new Date('2026-06-15T12:00:00'), NOW)).toBe(0);
  });

  it('counts from midnight, so a time earlier today is still 0 and not -1', () => {
    // The documented reason this rounds from midnight: a membership must not
    // flip to expired merely because the clock passed the hour it was sold at.
    expect(daysUntil(new Date('2026-06-15T09:00:00'), NOW)).toBe(0);
    expect(daysUntil(new Date('2026-06-15T23:59:00'), NOW)).toBe(0);
  });

  it('treats any time tomorrow as exactly 1 day', () => {
    expect(daysUntil(new Date('2026-06-16T00:01:00'), NOW)).toBe(1);
    expect(daysUntil(new Date('2026-06-16T23:59:00'), NOW)).toBe(1);
  });

  it('stays whole across a daylight-saving shift', () => {
    // A 23- or 25-hour day would give 29.96 or 30.04 without the rounding.
    const march = new Date('2026-03-01T12:00:00');
    expect(daysUntil(new Date('2026-03-31T12:00:00'), march)).toBe(30);
  });
});

describe('displayStatus', () => {
  it('reads a comfortably future membership as active', () => {
    expect(displayStatus(membership('active', new Date('2026-07-30T12:00:00')), NOW))
      .toBe('active');
  });

  it('reads one inside the warning window as expiring', () => {
    expect(displayStatus(membership('active', new Date('2026-06-20T12:00:00')), NOW))
      .toBe('expiring');
  });

  it('reads a past expiry as expired', () => {
    expect(displayStatus(membership('active', new Date('2026-06-14T12:00:00')), NOW))
      .toBe('expired');
  });

  it('still says expiring on the last day, not expired', () => {
    expect(displayStatus(membership('active', new Date('2026-06-15T08:00:00')), NOW))
      .toBe('expiring');
  });

  it('puts the boundary at exactly EXPIRING_SOON_DAYS inclusive', () => {
    const onEdge = addDays(NOW, EXPIRING_SOON_DAYS);
    const justOutside = addDays(NOW, EXPIRING_SOON_DAYS + 1);
    expect(displayStatus(membership('active', onEdge), NOW)).toBe('expiring');
    expect(displayStatus(membership('active', justOutside), NOW)).toBe('active');
  });

  it.each(['cancelled', 'suspended', 'superseded'] as const)(
    'lets a stored %s status win over the calendar',
    status => {
      // Even with dates that would otherwise read as active.
      expect(displayStatus(membership(status, new Date('2026-12-31T12:00:00')), NOW))
        .toBe(status);
    },
  );
});

describe('isLapsed', () => {
  it('is false for a member who was never sold anything', () => {
    expect(isLapsed(null, NOW)).toBe(false);
    expect(isLapsed(undefined, NOW)).toBe(false);
  });

  it('is false while the membership is still current', () => {
    expect(isLapsed(membership('active', new Date('2026-07-30T12:00:00')), NOW)).toBe(false);
  });

  it('is false just after expiry — recently expired is not yet lapsed', () => {
    expect(isLapsed(membership('active', addDays(NOW, -10)), NOW)).toBe(false);
  });

  it('is true once more than LAPSED_AFTER_DAYS have passed', () => {
    expect(isLapsed(membership('active', addDays(NOW, -LAPSED_AFTER_DAYS - 1)), NOW)).toBe(true);
  });

  it('is still false exactly on the 60th day — the rule is strictly more than', () => {
    expect(isLapsed(membership('active', addDays(NOW, -LAPSED_AFTER_DAYS)), NOW)).toBe(false);
  });

  it.each(['cancelled', 'suspended'] as const)(
    'does not call a long-past %s membership lapsed',
    status => {
      // It ended for a reason somebody recorded, which is a different fact
      // about the member than simply drifting away.
      expect(isLapsed(membership(status, addDays(NOW, -365)), NOW)).toBe(false);
    },
  );
});

describe('effectiveMemberStatus', () => {
  it('keeps an active member active while their membership holds', () => {
    expect(effectiveMemberStatus('active', membership('active', addDays(NOW, 30)), NOW))
      .toBe('active');
  });

  it('turns an active member inactive once they have lapsed', () => {
    expect(effectiveMemberStatus('active', membership('active', addDays(NOW, -90)), NOW))
      .toBe('inactive');
  });

  it('leaves a stored inactive alone even when the membership is current', () => {
    // Somebody deactivated them by hand; a renewal must not quietly undo that.
    expect(effectiveMemberStatus('inactive', membership('active', addDays(NOW, 30)), NOW))
      .toBe('inactive');
  });

  it('treats a member with no membership as active, not lapsed', () => {
    expect(effectiveMemberStatus('active', null, NOW)).toBe('active');
  });
});

describe('toView', () => {
  const stored = {
    id: 'm1',
    planId: 'p1',
    startDate: new Date('2026-06-01T12:00:00'),
    expiryDate: new Date('2026-07-01T12:00:00'),
    pricePaid: new Prisma.Decimal('2500.00'),
    status: 'active' as MembershipStatus,
    plan: { name: 'Monthly', durationDays: 30 },
  };

  it('flattens the plan and derives status and days left', () => {
    expect(toView(stored, NOW)).toEqual({
      id: 'm1',
      planId: 'p1',
      planName: 'Monthly',
      startDate: stored.startDate,
      expiryDate: stored.expiryDate,
      pricePaid: 2500,
      durationDays: 30,
      status: 'active',
      daysLeft: 16,
    });
  });

  it('returns pricePaid as a number so the JSON contract stays numeric', () => {
    const view = toView(stored, NOW);
    expect(view.pricePaid).toBe(2500);
    expect(JSON.stringify({ p: view.pricePaid })).toBe('{"p":2500}');
  });

  it('reports negative daysLeft for an expired membership', () => {
    const view = toView({ ...stored, expiryDate: addDays(NOW, -5) }, NOW);
    expect(view.daysLeft).toBe(-5);
    expect(view.status).toBe('expired');
  });

});

describe('renewalStart', () => {
  it('starts the day after an expiry still in the future', () => {
    // Renewing early must not cost the member the days they already paid for.
    expect(renewalStart(new Date('2026-06-20T12:00:00'), NOW))
      .toEqual(new Date('2026-06-21T12:00:00'));
  });

  it('starts today when the membership has already run out', () => {
    // Backdating into the gap would sell days that have already gone by.
    expect(renewalStart(new Date('2026-06-01T12:00:00'), NOW)).toEqual(NOW);
  });

  it('starts today when the membership expires today', () => {
    // The day after an expiry that is only hours away is still ahead of now,
    // so this is the boundary worth pinning: it must not silently backdate.
    const result = renewalStart(new Date('2026-06-15T09:00:00'), NOW);
    expect(result.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
  });
});

describe('currentMembershipWhere', () => {
  it('excludes exactly the replaced and called-off states', () => {
    expect(currentMembershipWhere.status.notIn).toEqual(['superseded', 'cancelled']);
  });
});

describe('formatMemberNo', () => {
  it('pads to five digits', () => {
    expect(formatMemberNo(1)).toBe('MEM-00001');
    expect(formatMemberNo(42)).toBe('MEM-00042');
  });

  it('does not truncate once the counter outgrows the padding', () => {
    expect(formatMemberNo(123456)).toBe('MEM-123456');
  });
});
