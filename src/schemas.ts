/** @format */

import { z } from "zod";

// --- shared primitives -------------------------------------------------

const uuid = z.uuid("must be a valid id");

const name = z.string().trim().min(1, "is required").max(100, "is too long");

// The client sends "" for cleared optional text fields; treat that as null.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "is too long")
    .transform((v) => v || null)
    .nullish();

// Numbers arrive as strings from HTML inputs, so coerce — but reject the
// values parseFloat would silently turn into NaN.
const money = z.coerce
  .number({ error: "must be a number" })
  .finite("must be a number")
  .nonnegative("cannot be negative")
  .max(10_000_000, "is unrealistically large");

const wholeNumber = z.coerce
  .number({ error: "must be a number" })
  .int("must be a whole number")
  .nonnegative("cannot be negative")
  .max(1_000_000, "is unrealistically large");

// new Date("garbage") yields an Invalid Date that only blows up at the DB.
const date = z.coerce.date({ error: "must be a valid date" });

export const GENDERS = ["male", "female", "other"] as const;
export const PAYMENT_METHODS = ["cash", "online"] as const;
export const PAYMENT_STATUSES = ["paid", "due"] as const;
export const PAYMENT_TYPES = ["membership", "supplement", "other"] as const;
export const SUPPLEMENT_CATEGORIES = [
  "protein",
  "creatine",
  "preworkout",
  "bcaa",
  "vitamins",
  "fatburner",
  "other",
] as const;

export const STAFF_PERMISSIONS = [
  "manager",
  "members_manager",
  "accountant",
  "receptionist",
  "inventory_manager",
] as const;

// Member photos are base64 data-URLs; anything else would be rendered
// straight into an <img src>.
const photo = z
  .string()
  .regex(/^data:image\/(jpeg|jpg|png|webp|gif);base64,/, "must be an image")
  .max(4_000_000, "is too large")
  .or(z.literal("").transform(() => null))
  .nullish();

// --- params ------------------------------------------------------------

export const idParam = z.object({ id: uuid });

/** A membership hangs off a member, so its routes carry both ids. */
export const membershipParams = z.object({ id: uuid, membershipId: uuid });

// --- auth --------------------------------------------------------------

export const registerSchema = z.object({
  gymName: name,
  ownerName: name,
  email: z.email("must be a valid email address").max(255).toLowerCase(),
  password: z
    .string()
    .min(8, "must be at least 8 characters")
    .max(200, "is too long"),
  phone: optionalText(30),
});

export const loginSchema = z.object({
  email: z.string().trim().min(1, "is required").toLowerCase(),
  password: z.string().min(1, "is required"),
});

const password = z
  .string()
  .min(8, "must be at least 8 characters")
  .max(200, "is too long");
const email = z.email("must be a valid email address").max(255).toLowerCase();

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "is required"),
  password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "is required"),
  newPassword: password,
});

export const googleAuthSchema = z.object({
  credential: z.string().min(1, "is required"),
});

// --- users (staff & member logins) -------------------------------------

/**
 * Password is optional on both: omitting it sends an invite instead, and the
 * person sets their own. An owner who knows every password is a worse default
 * than one who knows none, but a gym whose helper has no working email still
 * has to be able to hand over a login, so both routes stay open.
 */
export const createStaffSchema = z.object({
  name,
  email,
  password: password.optional(),
  staffPermission: z.enum(STAFF_PERMISSIONS).optional(),
});

export const createMemberLoginSchema = z.object({
  memberId: uuid,
  email,
  password: password.optional(),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1, "is required"),
  password,
});

/**
 * Roles the owner may assign to somebody else.
 *
 * `owner` is absent on purpose: promoting a second owner is what
 * transfer-ownership does, in one transaction, so the gym is never left with
 * two owners or none. Allowing it here would be a second, unguarded way in.
 */
export const ASSIGNABLE_ROLES = ["staff", "member"] as const;

export const updateUserSchema = z.object({
  name: name.optional(),
  isActive: z.boolean().optional(),
  role: z
    .enum(ASSIGNABLE_ROLES, { error: "must be staff or member" })
    .optional(),
  staffPermission: z.enum(STAFF_PERMISSIONS).optional().nullable(),
});

export const transferOwnershipSchema = z.object({ userId: uuid });

// --- members -----------------------------------------------------------

// Nothing in a list query may be required: the page loads with no filters at
// all. Blank values are dropped rather than rejected, so an empty search box or
// a cleared date input is a no-op instead of a 400.
const blankToUndefined = z.literal("").transform(() => undefined);

// A birth date in the future is a typo, and nobody is 120.
const birthDate = z.coerce
  .date({ error: "must be a valid date" })
  .refine((d) => d <= new Date(), "cannot be in the future")
  .refine((d) => d >= new Date("1900-01-01"), "is not a real date")
  .nullish();

const memberBase = {
  name,
  email: z
    .email("must be a valid email address")
    .max(255)
    .toLowerCase()
    .or(z.literal("").transform(() => null))
    .nullish(),
  phone: optionalText(30),
  photo,
  gender: z
    .enum(GENDERS, { error: "must be male, female or other" })
    .or(z.literal("").transform(() => null))
    .nullish(),
  dateOfBirth: birthDate,
  address: optionalText(500),
  emergencyContact: optionalText(100),
};

// Membership details are no longer part of a member. A member can be created
// with a plan attached in one call, but the expiry that follows from it is the
// server's to work out — see membershipStartSchema.
export const createMemberSchema = z
  .object({
    ...memberBase,
    planId: uuid.optional(),
    startDate: date.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.startDate && !data.planId) {
      ctx.addIssue({
        code: "custom",
        path: ["planId"],
        message: "is required when a start date is given",
      });
    }
  });

/**
 * The status tabs the members page offers. Every one of these is derived from
 * dates at read time rather than stored, so the controller turns them into date
 * arithmetic instead of a column match — see `memberStatusWhere`.
 *
 * `superseded` is deliberately absent: it is bookkeeping between two
 * memberships, not something a member is ever shown as.
 */
export const MEMBER_STATUS_FILTERS = [
  "active",
  "expiring",
  "expired",
  "lapsed",
  "none",
] as const;

export const memberQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(100, "is too long")
    .transform((v) => v || undefined)
    .optional(),
  status: z
    .enum(MEMBER_STATUS_FILTERS, { error: "is not a valid status filter" })
    .or(blankToUndefined)
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  // Capped at 100 like the audit log: the ceiling is what stops a caller
  // asking for the whole table back through the page parameter.
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * Opt out of paging and return every member, for the pickers that need a
   * complete list — the payment form's member dropdown cannot offer only the
   * first 25 people in the gym.
   *
   * Deliberately explicit rather than the default: a caller asking for
   * everything should have to say so, so the expensive shape is the one you
   * choose rather than the one you get by forgetting. Photos are dropped from
   * this response, which is what keeps it affordable — see the controller.
   */
  all: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const updateMemberSchema = z.object({
  ...memberBase,
  name: name.optional(),
});

export const updateMyProfileSchema = z.object({
  phone: optionalText(30).optional(),
  email: z
    .email("must be a valid email address")
    .max(255)
    .toLowerCase()
    .or(z.literal("").transform(() => null))
    .nullish(),
  address: optionalText(500).optional(),
  emergencyContact: optionalText(100).optional(),
});

export const importMembersSchema = z.object({
  csv: z.string().trim().min(1, "CSV is required"),
});

// --- membership plans --------------------------------------------------

const planBase = {
  name,
  price: money,
  durationDays: z.coerce
    .number({ error: "must be a number" })
    .int("must be a whole number")
    .min(1, "must be at least 1 day")
    .max(3650, "cannot be more than 10 years"),
  isActive: z.boolean().optional(),
};

export const createMembershipPlanSchema = z.object(planBase);

export const updateMembershipPlanSchema = z.object({
  ...planBase,
  name: name.optional(),
  price: money.optional(),
  durationDays: planBase.durationDays.optional(),
});

export const membershipPlanQuerySchema = z.object({
  // Query strings carry "true"/"false", not booleans.
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

// --- memberships -------------------------------------------------------

// The client picks a plan and a start date; expiry follows from the plan's
// duration and is never accepted from the request.
export const createMembershipSchema = z.object({
  planId: uuid,
  startDate: date.optional(),
});

/**
 * Granting extra days. Only ever forwards — shortening an expiry is a
 * different action with different trust implications, and is not this route's
 * job. The reason is required because the audit entry is the entire point:
 * free days are money, and money given away needs a why next to it.
 */
export const extendMembershipSchema = z.object({
  days: z.coerce
    .number({ error: "must be a number" })
    .int("must be a whole number")
    .min(1, "must be at least 1 day")
    .max(365, "cannot be more than 365 days"),
  reason: z.string().trim().min(3, "is required").max(200, "is too long"),
});

// --- audit logs --------------------------------------------------------

export const auditLogQuerySchema = z
  .object({
    entity: z.string().trim().max(40).optional(),
    actorId: uuid.optional(),
    from: date.optional(),
    to: date.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .superRefine((data, ctx) => {
    if (data.from && data.to && data.to < data.from) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "must be after the from date",
      });
    }
  });

// --- attendance --------------------------------------------------------

export const checkinSchema = z.object({ memberId: uuid });

// --- payments ----------------------------------------------------------

export const createPaymentSchema = z.object({
  memberId: uuid,
  amount: money.refine((v) => v > 0, "must be greater than zero"),
  method: z
    .enum(PAYMENT_METHODS, { error: "must be cash or online" })
    .optional(),
  status: z.enum(PAYMENT_STATUSES, { error: "must be paid or due" }).optional(),
  type: z
    .enum(PAYMENT_TYPES, { error: "is not a valid payment type" })
    .optional(),
  // Which membership this settles. The controller checks it belongs to this
  // gym and to the member being paid for; null is a legitimate answer for
  // money that has no membership behind it.
  membershipId: uuid.nullish(),
  notes: optionalText(500),
  paymentDate: date.optional(),
});

export const updatePaymentSchema = z.object({
  // The member a payment belongs to is deliberately not editable — moving money
  // between members is a delete and a fresh entry, so both show in the trail.
  amount: money.refine((v) => v > 0, "must be greater than zero").optional(),
  method: z
    .enum(PAYMENT_METHODS, { error: "must be cash or online" })
    .optional(),
  status: z.enum(PAYMENT_STATUSES, { error: "must be paid or due" }).optional(),
  type: z
    .enum(PAYMENT_TYPES, { error: "is not a valid payment type" })
    .optional(),
  membershipId: uuid.nullish(),
  notes: optionalText(500),
  paymentDate: date.optional(),
});

export const paymentQuerySchema = z
  .object({
    status: z
      .enum(PAYMENT_STATUSES, { error: "must be paid or due" })
      .or(blankToUndefined)
      .optional(),
    type: z
      .enum(PAYMENT_TYPES, { error: "is not a valid payment type" })
      .or(blankToUndefined)
      .optional(),
    search: z
      .string()
      .trim()
      .max(100, "is too long")
      .transform((v) => v || undefined)
      .optional(),
    from: date.or(blankToUndefined).optional(),
    to: date.or(blankToUndefined).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .superRefine((data, ctx) => {
    if (data.from && data.to && data.to < data.from) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "must be after the from date",
      });
    }
  });

// --- plans -------------------------------------------------------------

export const createPlanSchema = z.object({
  name,
  description: optionalText(2000),
});

export const assignPlanSchema = z.object({
  memberId: uuid,
  workoutPlanId: uuid.nullish(),
  dietPlanId: uuid.nullish(),
});

// --- supplements -------------------------------------------------------

const supplementBase = {
  name,
  category: z.enum(SUPPLEMENT_CATEGORIES, { error: "is not a valid category" }),
  description: optionalText(1000),
  dosage: optionalText(200),
  timing: optionalText(200),
  price: money.nullish(),
  stock: wholeNumber.optional(),
};

export const createSupplementSchema = z.object(supplementBase);

export const updateSupplementSchema = z.object({
  ...supplementBase,
  name: name.optional(),
  category: supplementBase.category.optional(),
});

/**
 * Selling across the counter. The price is not accepted from the client: it is
 * read from the supplement, the same reason a membership's expiry is derived
 * on the server. A price the front desk can type is a price the front desk can
 * quietly discount.
 */
export const sellSupplementSchema = z.object({
  quantity: z.coerce
    .number({ error: "must be a number" })
    .int("must be a whole number")
    .min(1, "must be at least 1")
    .max(1000, "is unrealistically large"),
  /// Null for a walk-in: the gym still took the money.
  memberId: uuid.nullish(),
  notes: optionalText(500),
  soldAt: date.optional(),
});

/** Stock arriving from a supplier. Separate from `update` so restocking is an
 *  event with a reason, not an untraceable edit to a number. */
export const restockSupplementSchema = z.object({
  quantity: z.coerce
    .number({ error: "must be a number" })
    .int("must be a whole number")
    .min(1, "must be at least 1")
    .max(100_000, "is unrealistically large"),
  notes: optionalText(500),
});

/** How many months of history the sales report covers. */
export const salesReportQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});

/** Same window as the sales report, so the two pages line up month for month. */
export const paymentSummaryQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});

/**
 * One month's collection, member by member.
 *
 * The month is named rather than described as a range, because that is the
 * question being asked — "who paid in August" — and a free range would let the
 * page claim a month while showing something else. Parsed into parts here so
 * the controller builds the window in local time; `new Date('2026-08')` would
 * read as UTC and pull a neighbouring month in for any timezone but this one.
 */
export const monthlyCollectionQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be a month in YYYY-MM form")
    .transform((v) => {
      const [year, month] = v.split("-").map(Number) as [number, number];
      return { value: v, year, month };
    }),
  search: z
    .string()
    .trim()
    .max(100, "is too long")
    .transform((v) => v || undefined)
    .optional(),
  /**
   * Which side of the month is being asked about.
   *
   * `paid` and `unpaid` are not two filters over one list — they are answers to
   * two different questions. "Who paid" is driven by payment rows; "who has not"
   * cannot be, because a member who paid nothing at all has no row to filter.
   * That side is driven by memberships instead, so somebody who never came near
   * the counter still appears.
   */
  view: z.enum(["paid", "unpaid", "all"]).default("paid"),
  /** Whether unpaid dues for the month are listed alongside what was collected.
   *  Applies to the `paid` view only; the `unpaid` view is dues by definition. */
  includeDue: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// --- inferred request-body types ---------------------------------------

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
export type GoogleAuthBody = z.infer<typeof googleAuthSchema>;
export type CreateStaffBody = z.infer<typeof createStaffSchema>;
export type CreateMemberLoginBody = z.infer<typeof createMemberLoginSchema>;
export type AcceptInviteBody = z.infer<typeof acceptInviteSchema>;
export type UpdateUserBody = z.infer<typeof updateUserSchema>;
export type TransferOwnershipBody = z.infer<typeof transferOwnershipSchema>;
export type CreateMemberBody = z.infer<typeof createMemberSchema>;
export type UpdateMemberBody = z.infer<typeof updateMemberSchema>;
export type MemberQuery = z.infer<typeof memberQuerySchema>;
export type MemberStatusFilter = (typeof MEMBER_STATUS_FILTERS)[number];
export type CreateMembershipPlanBody = z.infer<
  typeof createMembershipPlanSchema
>;
export type UpdateMembershipPlanBody = z.infer<
  typeof updateMembershipPlanSchema
>;
export type MembershipPlanQuery = z.infer<typeof membershipPlanQuerySchema>;
export type CreateMembershipBody = z.infer<typeof createMembershipSchema>;
export type ExtendMembershipBody = z.infer<typeof extendMembershipSchema>;
export type MembershipParams = z.infer<typeof membershipParams>;
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type CheckinBody = z.infer<typeof checkinSchema>;
export type CreatePaymentBody = z.infer<typeof createPaymentSchema>;
export type UpdatePaymentBody = z.infer<typeof updatePaymentSchema>;
export type PaymentQuery = z.infer<typeof paymentQuerySchema>;
export type PaymentSummaryQuery = z.infer<typeof paymentSummaryQuerySchema>;
export type MonthlyCollectionQuery = z.infer<
  typeof monthlyCollectionQuerySchema
>;
export type CreatePlanBody = z.infer<typeof createPlanSchema>;
export type AssignPlanBody = z.infer<typeof assignPlanSchema>;
export type CreateSupplementBody = z.infer<typeof createSupplementSchema>;
export type UpdateSupplementBody = z.infer<typeof updateSupplementSchema>;
export type SellSupplementBody = z.infer<typeof sellSupplementSchema>;
export type RestockSupplementBody = z.infer<typeof restockSupplementSchema>;
export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;
export type IdParam = z.infer<typeof idParam>;

export type Gender = (typeof GENDERS)[number];
