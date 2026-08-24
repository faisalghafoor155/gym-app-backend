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

/**
 * Where an online payment actually came through.
 *
 * Only meaningful alongside `method: "online"` — cash has no channel, and
 * saying otherwise on a cash row would put a wallet's name on money that was
 * handed over the counter.
 */
export const PAYMENT_CHANNELS = ["easypaisa", "jazzcash", "bank"] as const;
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
  trainerId: uuid.or(z.literal("").transform(() => null)).nullish(),
  /**
   * What the front desk agreed for the trainer assignment, when it was
   * haggled rather than taken from the price list.
   *
   * Null or absent means "use the trainer's rate, then the gym's" — the
   * common case, which should need no typing. An explicit 0 charges nothing.
   * Only read when a trainer is actually being assigned; sent without one it
   * is ignored rather than rejected, since a form that keeps the field around
   * while the trainer picker is empty is not making an error.
   *
   * The empty-string branch comes FIRST deliberately. `money` is
   * `z.coerce.number()`, and coercion turns `""` into `0` — so with the
   * branches the other way round a blank field would silently mean "charge
   * nothing" instead of "use the default", and the gym's price would never
   * apply.
   */
  ptFee: z
    .literal("")
    .transform(() => null)
    .or(money)
    .nullish(),
  /**
   * Whether the trainer fee was collected at the counter there and then.
   *
   * Defaults to false, which records a due — the safe answer, since claiming
   * money arrived when it did not is the worse error of the two. At
   * registration the cash usually is taken on the spot, so this saves the
   * front desk a second trip to the Payments page to settle a fee they are
   * holding in their hand.
   *
   * A strict boolean, deliberately not `z.coerce.boolean()`: coercion is
   * JavaScript truthiness, so the string `"false"` would arrive as `true` and
   * silently mark an uncollected fee as paid. The client sends JSON, so it has
   * a real boolean to send.
   */
  ptFeePaid: z.boolean().optional(),
};

// Membership details are no longer part of a member. A member can be created
// with a plan attached in one call, but the expiry that follows from it is the
// server's to work out — see membershipStartSchema.
export const createMemberSchema = z
  .object({
    ...memberBase,
    planId: uuid.optional(),
    startDate: date.optional(),
    /**
     * The joining fee taken at the counter, if any was.
     *
     * Absent means no money changed hands — the member is registered and can
     * be billed later from the Payments page. A zero is not a payment either:
     * a nil receipt is not a receipt.
     */
    feeAmount: z
      .literal("")
      .transform(() => null)
      .or(money)
      .nullish(),
    /** How that fee was taken. Only read when `feeAmount` is set. */
    feeMethod: z
      .enum(PAYMENT_METHODS, { error: "must be cash or online" })
      .optional(),
    feeChannel: z
      .enum(PAYMENT_CHANNELS, { error: "is not a payment channel we take" })
      .or(blankToUndefined)
      .nullish(),
    feeReference: optionalText(100),
  })
  .superRefine((data, ctx) => {
    if (data.feeMethod === "cash" && data.feeChannel) {
      ctx.addIssue({
        code: "custom",
        path: ["feeChannel"],
        message: "cannot be set on a cash payment",
      });
    }
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
  /**
   * Narrows the roster to one gender — what a gym needs to work through the
   * women's list on ladies' day, or count either side of the floor.
   *
   * Absent means everyone, including the members whose gender was never
   * recorded. Those are the majority of older rows, so a filter that dropped
   * them by default would hide most of the gym.
   */
  gender: z
    .enum(GENDERS, { error: "must be male, female or other" })
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
  /**
   * Set when the member asks not to be messaged on WhatsApp.
   *
   * Only on update, never on create: nobody opts out before they have been
   * registered, and a box on the registration form invites a receptionist to
   * answer it on the member's behalf.
   */
  whatsappOptOut: z.boolean().optional(),
});

/**
 * What the add-member form asks before it has a whole member to send.
 *
 * Everything is optional: the form asks as soon as it has the phone, and again
 * once the name and date of birth are both filled. `excludeId` is what an edit
 * passes so the member being edited is not reported as its own duplicate.
 */
export const memberDuplicateQuerySchema = z.object({
  name: z
    .string()
    .trim()
    .max(100, "is too long")
    .transform((v) => v || undefined)
    .optional(),
  phone: z
    .string()
    .trim()
    .max(30, "is too long")
    .transform((v) => v || undefined)
    .optional(),
  dateOfBirth: date.or(blankToUndefined).optional(),
  excludeId: uuid.or(blankToUndefined).optional(),
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

/** Which wallet the money came through, and its transaction id. Declared here
 *  rather than with the payment schemas because renewal, which comes first in
 *  this file, takes the money as well as selling the days. */
const paymentChannelFields = {
  channel: z
    .enum(PAYMENT_CHANNELS, { error: "is not a payment channel we take" })
    .or(blankToUndefined)
    .nullish(),
  reference: optionalText(100),
};

/**
 * A cash payment must not claim a channel.
 *
 * Otherwise a row reads "cash, via JazzCash", which is two different answers
 * to where the money is — and the one the books would reconcile against is
 * whichever the reader happened to look at.
 */
const rejectChannelOnCash = (
  data: { method?: string; channel?: string | null },
  ctx: z.RefinementCtx,
): void => {
  if (data.method === "cash" && data.channel) {
    ctx.addIssue({
      code: "custom",
      path: ["channel"],
      message: "cannot be set on a cash payment",
    });
  }
};

/**
 * Renewing: the next period, and the money for it, in one request.
 *
 * The amount is required and must be positive — a renewal is the gym being
 * paid, and one recorded without a payment would grant days the books never
 * saw. Discounts are expressed by sending a smaller amount than the plan's
 * price, which is why this is a free figure rather than taken from the plan.
 *
 * `planId` is optional: absent means "the same plan again", which is the
 * common case. Sending one renews onto a different plan.
 *
 * No start date. It follows from the membership being renewed — the day after
 * it ends — so it cannot be typed, for the same reason an expiry cannot be.
 */
export const renewMembershipSchema = z
  .object({
    planId: uuid.optional(),
    amount: money.refine((v) => v > 0, "must be greater than zero"),
    method: z.enum(PAYMENT_METHODS, { error: "must be cash or online" }),
    ...paymentChannelFields,
  })
  .superRefine(rejectChannelOnCash);

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

// --- fingerprint -------------------------------------------------------

/**
 * A template as it arrives over the wire: base64, because JSON has no way to
 * carry bytes. Decoded to a Buffer at the controller and stored as `Bytes` —
 * the encoding is a transport detail and does not reach the database.
 *
 * The ceiling is generous by the standards of the hardware. Vendor templates
 * run to a few hundred bytes and the largest in common use is under 2 KB; 64 KB
 * of base64 is roughly 48 KB decoded, which no reader will produce and which is
 * small enough that a bad request cannot be used to push anything substantial
 * into the row.
 */
const fingerprintTemplate = z
  .string()
  .min(1, "is required")
  .max(65_536, "is too large")
  .refine(
    (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0,
    "must be base64",
  );

export const enrollFingerprintSchema = z.object({
  memberId: uuid,
  template: fingerprintTemplate,
  /** Whose encoding the template is in. Must match the active device, which
   *  the controller checks — a template from a reader the gym no longer owns
   *  is unmatchable, and storing it would only fail later at the desk. */
  format: z.string().trim().min(1, "is required").max(50, "is too long"),
  /** Free text, for the desk's benefit: "right thumb". Nothing branches on it. */
  finger: z.string().trim().max(30, "is too long").optional(),
});

/**
 * A check-in attempt from the reader.
 *
 * Both fields are optional and exactly one is expected, which the controller
 * enforces rather than the schema: which one arrives depends on whether the
 * device matches internally, and that is a fact about the hardware the client
 * should not have to encode as a request shape. A device that matched locally
 * sends `externalId`; one that did not sends the `template` it captured.
 */
export const identifyFingerprintSchema = z.object({
  externalId: uuid.optional(),
  template: fingerprintTemplate.optional(),
  format: z.string().trim().min(1).max(50).optional(),
});

// --- payments ----------------------------------------------------------

export const createPaymentSchema = z
  .object({
    memberId: uuid,
    amount: money.refine((v) => v > 0, "must be greater than zero"),
    method: z
      .enum(PAYMENT_METHODS, { error: "must be cash or online" })
      .optional(),
    status: z
      .enum(PAYMENT_STATUSES, { error: "must be paid or due" })
      .optional(),
    type: z
      .enum(PAYMENT_TYPES, { error: "is not a valid payment type" })
      .optional(),
    // Which membership this settles. The controller checks it belongs to this
    // gym and to the member being paid for; null is a legitimate answer for
    // money that has no membership behind it.
    membershipId: uuid.nullish(),
    notes: optionalText(500),
    paymentDate: date.optional(),
    ...paymentChannelFields,
  })
  .superRefine(rejectChannelOnCash);

export const updatePaymentSchema = z
  .object({
    // The member a payment belongs to is deliberately not editable — moving
    // money between members is a delete and a fresh entry, so both show in the
    // trail.
    amount: money.refine((v) => v > 0, "must be greater than zero").optional(),
    method: z
      .enum(PAYMENT_METHODS, { error: "must be cash or online" })
      .optional(),
    status: z
      .enum(PAYMENT_STATUSES, { error: "must be paid or due" })
      .optional(),
    type: z
      .enum(PAYMENT_TYPES, { error: "is not a valid payment type" })
      .optional(),
    membershipId: uuid.nullish(),
    notes: optionalText(500),
    paymentDate: date.optional(),
    ...paymentChannelFields,
  })
  .superRefine(rejectChannelOnCash);

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

export const workoutExerciseSchema = z.object({
  name: z.string().trim().min(1, "is required"),
  sets: z.coerce.number().int().min(1),
  reps: z.string().trim().min(1),
  weight: z.string().trim(),
});

export const dailyWorkoutSchema = z.object({
  day: z.string().trim().min(1),
  exercises: z.array(workoutExerciseSchema),
});

export const workoutDataSchema = z.object({
  days: z.array(dailyWorkoutSchema),
});

export const dietItemSchema = z.object({
  name: z.string().trim().min(1, "is required"),
  amount: z.string().trim().min(1),
  calories: z.coerce.number().int().min(0),
});

export const dietMealSchema = z.object({
  name: z.string().trim().min(1),
  items: z.array(dietItemSchema),
});

export const dietDataSchema = z.object({
  meals: z.array(dietMealSchema),
});

export const createPlanSchema = z.object({
  name,
  description: optionalText(2000),
  workoutData: workoutDataSchema.optional(),
  dietData: dietDataSchema.optional(),
});

export const assignPlanSchema = z.object({
  memberId: uuid,
  workoutPlanId: uuid.nullish(),
  dietPlanId: uuid.nullish(),
});

export const trainerIdParam = z.object({ trainerId: uuid });


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

export const checkoutCartSchema = z.object({
  memberId: uuid.nullish(),
  paymentMethod: z.enum(['cash', 'card']).default('cash'),
  notes: optionalText(500),
  items: z.array(z.object({
    supplementId: uuid,
    quantity: z.coerce.number().int().min(1).max(1000),
  })).min(1, 'must have at least one item'),
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

export const createTrainerSchema = z.object({
  name: name,
  phone: optionalText(50),
  specialization: optionalText(100),
  commissionPercentage: z.coerce.number().min(0).max(100).default(0),
  /** Null (or absent) means "charge whatever the gym charges", which is not
   *  the same as 0 — that is a deliberate decision to charge nothing. */
  ptFee: money.nullish(),
});

export const updateTrainerSchema = createTrainerSchema.partial();

export const createPtSessionSchema = z.object({
  memberId: uuid,
  trainerId: uuid,
  sessionDate: z.coerce.date(),
  priceCharged: money,
  status: z.enum(['scheduled', 'completed', 'cancelled']).optional().default('scheduled'),
  paymentStatus: z.enum(['unpaid', 'paid']).optional().default('unpaid'),
});

export const updatePtSessionSchema = z.object({
  sessionDate: z.coerce.date().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
  paymentStatus: z.enum(['unpaid', 'paid']).optional(),
});

export const createClassSchema = z.object({
  name: name,
  description: optionalText(500),
});

export const createClassScheduleSchema = z.object({
  classId: uuid,
  trainerId: uuid.or(z.literal("").transform(() => null)).nullish(),
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  startTime: z.string().trim().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, "must be in HH:MM format"),
  endTime: z.string().trim().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, "must be in HH:MM format"),
  capacity: z.coerce.number().int().min(1).default(20),
});

export const createClassBookingSchema = z.object({
  scheduleId: uuid,
  memberId: uuid,
  bookingDate: z.coerce.date(),
});

export const updateClassBookingSchema = z.object({
  status: z.enum(['booked', 'attended', 'cancelled']),
});

// --- expenses ----------------------------------------------------------

/**
 * The categories the client offers as suggestions. Not an enum on the column:
 * a gym's spending is its own, and anything typed here is accepted — these are
 * only what the picker shows first.
 */
export const EXPENSE_CATEGORIES = [
  'rent',
  'utilities',
  'salaries',
  'equipment',
  'maintenance',
  'marketing',
  'supplies',
  'other',
] as const;

const expenseFields = {
  category: z.string().trim().min(1, 'is required').max(50, 'is too long'),
  amount: money.refine((v) => v > 0, 'must be greater than zero'),
  spentOn: date,
  vendor: optionalText(120),
  notes: optionalText(500),
};

export const createExpenseSchema = z.object(expenseFields);

/** Every field optional, but the same rules — a partial update must not be a
 *  way to store an amount the create path would have rejected. */
export const updateExpenseSchema = z.object(expenseFields).partial();

export const expenseQuerySchema = z
  .object({
    category: z
      .string()
      .trim()
      .max(50)
      .transform((v) => v || undefined)
      .optional(),
    search: z
      .string()
      .trim()
      .max(100, 'is too long')
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
        code: 'custom',
        path: ['to'],
        message: 'must be after the from date',
      });
    }
  });

/** The profit report's window. Both ends optional — no bounds means all time. */
export const profitQuerySchema = z
  .object({
    from: date.or(blankToUndefined).optional(),
    to: date.or(blankToUndefined).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.from && data.to && data.to < data.from) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'must be after the from date',
      });
    }
  });

// --- gym settings ------------------------------------------------------

/** Gym-wide settings the owner can change. */
export const updateGymSettingsSchema = z.object({
  /** What a trainer assignment costs when the trainer sets no price of their
   *  own. Zero is valid and means the gym charges nothing for it. */
  defaultPtFee: money,
  /**
   * Where members are told to send money. Free text, because a wallet is a
   * phone number and a bank is a name plus an IBAN. Blank clears the channel's
   * published details without hiding the channel itself.
   */
  easypaisaAccount: optionalText(200).optional(),
  jazzcashAccount: optionalText(200).optional(),
  bankAccount: optionalText(300).optional(),
});

// --- online payments ---------------------------------------------------

/**
 * Starting a checkout. Note what is *not* here: no amount.
 *
 * The price is read from the plan or the due row on the server, because a
 * request that can name its own price is a request that can buy a membership
 * for one rupee.
 *
 * `superRefine` rather than two schemas: which id is required depends on
 * `type`, and letting a `renew` through without a `planId` would only fail
 * later, in the controller, as a 404 that reads like the plan was missing.
 */
export const checkoutSchema = z
  .object({
    type: z.enum(['due', 'renew']),
    planId: uuid.optional(),
    paymentId: uuid.optional(),
    provider: z.enum(['jazzcash', 'easypaisa', 'manual']),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'renew' && !val.planId) {
      ctx.addIssue({
        code: 'custom',
        path: ['planId'],
        message: 'planId is required to renew',
      });
    }
    if (val.type === 'due' && !val.paymentId) {
      ctx.addIssue({
        code: 'custom',
        path: ['paymentId'],
        message: 'paymentId is required to pay dues',
      });
    }
  });

/**
 * The provider in a callback URL. Constrained to the known set so an unknown
 * name is rejected by the router rather than reaching a `getGateway` lookup.
 */
export const providerParams = z.object({
  provider: z.enum(['jazzcash', 'easypaisa', 'manual']),
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
export type MemberDuplicateQuery = z.infer<typeof memberDuplicateQuerySchema>;
export type MemberStatusFilter = (typeof MEMBER_STATUS_FILTERS)[number];
export type CreateMembershipPlanBody = z.infer<
  typeof createMembershipPlanSchema
>;
export type UpdateMembershipPlanBody = z.infer<
  typeof updateMembershipPlanSchema
>;
export type MembershipPlanQuery = z.infer<typeof membershipPlanQuerySchema>;
export type CreateMembershipBody = z.infer<typeof createMembershipSchema>;
export type RenewMembershipBody = z.infer<typeof renewMembershipSchema>;
export type MembershipParams = z.infer<typeof membershipParams>;
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type CheckinBody = z.infer<typeof checkinSchema>;
export type EnrollFingerprintBody = z.infer<typeof enrollFingerprintSchema>;
export type IdentifyFingerprintBody = z.infer<typeof identifyFingerprintSchema>;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];
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
export type CheckoutCartBody = z.infer<typeof checkoutCartSchema>;
export type RestockSupplementBody = z.infer<typeof restockSupplementSchema>;
export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;
export type IdParam = z.infer<typeof idParam>;
export type TrainerIdParam = z.infer<typeof trainerIdParam>;

export type CreateTrainerBody = z.infer<typeof createTrainerSchema>;
export type UpdateTrainerBody = z.infer<typeof updateTrainerSchema>;
export type CreatePtSessionBody = z.infer<typeof createPtSessionSchema>;
export type UpdatePtSessionBody = z.infer<typeof updatePtSessionSchema>;

export type CreateClassBody = z.infer<typeof createClassSchema>;
export type CreateClassScheduleBody = z.infer<typeof createClassScheduleSchema>;
export type CreateClassBookingBody = z.infer<typeof createClassBookingSchema>;
export type UpdateClassBookingBody = z.infer<typeof updateClassBookingSchema>;

export type CreateExpenseBody = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseBody = z.infer<typeof updateExpenseSchema>;
export type ExpenseQuery = z.infer<typeof expenseQuerySchema>;
export type ProfitQuery = z.infer<typeof profitQuerySchema>;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type UpdateGymSettingsBody = z.infer<typeof updateGymSettingsSchema>;
export type CheckoutBody = z.infer<typeof checkoutSchema>;
export type ProviderParams = z.infer<typeof providerParams>;
export type ConfirmManualParams = z.infer<typeof idParam>;

export type Gender = (typeof GENDERS)[number];
