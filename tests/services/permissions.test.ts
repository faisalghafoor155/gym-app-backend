import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  STAFF_PERMISSIONS,
  getStaffPermissions,
  hasPermission,
} from '../../src/services/permissions.js';
import { OUTPUT, render } from '../../scripts/generatePermissions.js';

/**
 * The guard that replaces a hand-maintained second copy.
 *
 * The client needs the same permission table to decide what to render, and it
 * used to be a separate 150-line file kept in step by hand. It had already
 * begun to drift. The copy is now generated, and this fails the build if the
 * committed output stops matching what the generator produces — which is what
 * makes "edit one, forget the other" impossible rather than merely discouraged.
 */
describe('permission table', () => {
  it('the committed client copy matches its source', () => {
    const committed = readFileSync(OUTPUT, 'utf8');
    // If this fails, run `npm run gen:permissions` in backend/ and commit the
    // result — do not edit the generated file by hand.
    expect(committed.replace(/\r\n/g, '\n')).toBe(render().replace(/\r\n/g, '\n'));
  });

  it('every level has an entry, a label and a description', () => {
    for (const level of Object.keys(STAFF_PERMISSIONS)) {
      expect(PERMISSION_LABELS[level as keyof typeof PERMISSION_LABELS]).toBeTruthy();
      expect(
        PERMISSION_DESCRIPTIONS[level as keyof typeof PERMISSION_DESCRIPTIONS],
      ).toBeTruthy();
    }
  });

  it('every level defines every capability, so none is silently undefined', () => {
    // `undefined` is falsy, so a missing key would deny by accident rather
    // than by decision — and would read as a deliberate `false` in review.
    const keys = Object.keys(STAFF_PERMISSIONS.manager).sort();
    for (const [level, perms] of Object.entries(STAFF_PERMISSIONS)) {
      expect(Object.keys(perms).sort(), `${level} is missing capabilities`).toEqual(keys);
      for (const [key, value] of Object.entries(perms)) {
        expect(typeof value, `${level}.${key}`).toBe('boolean');
      }
    }
  });
});

describe('what each level may do', () => {
  it('manager has everything', () => {
    expect(Object.values(getStaffPermissions('manager')).every(Boolean)).toBe(true);
  });

  it('a receptionist can take a check-in but not record money', () => {
    expect(hasPermission('receptionist', 'canCheckIn')).toBe(true);
    expect(hasPermission('receptionist', 'canViewPayments')).toBe(true);
    // Deliberate: they can answer "have I paid?" without being able to make
    // the answer yes.
    expect(hasPermission('receptionist', 'canRecordPayments')).toBe(false);
  });

  it('a members manager cannot see the gym\'s reports', () => {
    expect(hasPermission('members_manager', 'canManageMembers')).toBe(true);
    expect(hasPermission('members_manager', 'canViewReports')).toBe(false);
  });

  it('an accountant keeps the books but does not sell memberships', () => {
    expect(hasPermission('accountant', 'canRecordPayments')).toBe(true);
    expect(hasPermission('accountant', 'canViewReports')).toBe(true);
    expect(hasPermission('accountant', 'canManageExpenses')).toBe(true);
    expect(hasPermission('accountant', 'canManageMemberships')).toBe(false);
  });

  it('an inventory manager can take money for stock but not manage members', () => {
    expect(hasPermission('inventory_manager', 'canSellSupplements')).toBe(true);
    expect(hasPermission('inventory_manager', 'canRecordPayments')).toBe(true);
    expect(hasPermission('inventory_manager', 'canManageMembers')).toBe(false);
  });

  it('only the manager may touch staff', () => {
    for (const level of Object.keys(STAFF_PERMISSIONS)) {
      const expected = level === 'manager';
      expect(hasPermission(level as never, 'canManageStaff'), level).toBe(expected);
      expect(hasPermission(level as never, 'canModifyStaff'), level).toBe(expected);
    }
  });

  it('expenses are the gym\'s books, not the front desk\'s', () => {
    expect(hasPermission('receptionist', 'canManageExpenses')).toBe(false);
    expect(hasPermission('members_manager', 'canManageExpenses')).toBe(false);
    expect(hasPermission('inventory_manager', 'canManageExpenses')).toBe(false);
  });
});
