import { z } from 'zod';

// --- shared primitives -------------------------------------------------

const uuid = z.uuid('must be a valid id');

const name = z.string().trim().min(1, 'is required').max(100, 'is too long');

// The client sends "" for cleared optional text fields; treat that as null.
const optionalText = (max: number) =>
  z.string().trim().max(max, 'is too long').transform(v => v || null).nullish();

// Numbers arrive as strings from HTML inputs, so coerce — but reject the
// values parseFloat would silently turn into NaN.
const money = z.coerce
  .number({ error: 'must be a number' })
  .finite('must be a number')
  .nonnegative('cannot be negative')
  .max(10_000_000, 'is unrealistically large');

const wholeNumber = z.coerce
  .number({ error: 'must be a number' })
  .int('must be a whole number')
  .nonnegative('cannot be negative')
  .max(1_000_000, 'is unrealistically large');

// new Date("garbage") yields an Invalid Date that only blows up at the DB.
const date = z.coerce.date({ error: 'must be a valid date' });

export const GENDERS = ['male', 'female', 'other'] as const;
export const PAYMENT_METHODS = ['cash', 'online'] as const;
export const PAYMENT_STATUSES = ['paid', 'due'] as const;
export const SUPPLEMENT_CATEGORIES = [
  'protein', 'creatine', 'preworkout', 'bcaa', 'vitamins', 'fatburner', 'other',
] as const;

// Member photos are base64 data-URLs; anything else would be rendered
// straight into an <img src>.
const photo = z.string()
  .regex(/^data:image\/(jpeg|jpg|png|webp|gif);base64,/, 'must be an image')
  .max(4_000_000, 'is too large')
  .or(z.literal('').transform(() => null))
  .nullish();

// --- params ------------------------------------------------------------

export const idParam = z.object({ id: uuid });

// --- auth --------------------------------------------------------------

export const registerSchema = z.object({
  gymName: name,
  ownerName: name,
  email: z.email('must be a valid email address').max(255).toLowerCase(),
  password: z.string().min(8, 'must be at least 8 characters').max(200, 'is too long'),
  phone: optionalText(30),
});


export const loginSchema = z.object({
  email: z.string().trim().min(1, 'is required').toLowerCase(),
  password: z.string().min(1, 'is required'),
});

const password = z.string().min(8, 'must be at least 8 characters').max(200, 'is too long');
const email = z.email('must be a valid email address').max(255).toLowerCase();

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'is required'),
  password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'is required'),
  newPassword: password,
});

export const googleAuthSchema = z.object({
  credential: z.string().min(1, 'is required'),
});

// --- users (staff & member logins) -------------------------------------

export const createStaffSchema = z.object({ name, email, password });

export const createMemberLoginSchema = z.object({
  memberId: uuid,
  email,
  password,
});

export const updateUserSchema = z.object({
  name: name.optional(),
  isActive: z.boolean().optional(),
});

export const transferOwnershipSchema = z.object({ userId: uuid });

// --- members -----------------------------------------------------------

// A birth date in the future is a typo, and nobody is 120.
const birthDate = z.coerce.date({ error: 'must be a valid date' })
  .refine(d => d <= new Date(), 'cannot be in the future')
  .refine(d => d >= new Date('1900-01-01'), 'is not a real date')
  .nullish();

const memberBase = {
  name,
  email: z.email('must be a valid email address').max(255).toLowerCase()
    .or(z.literal('').transform(() => null)).nullish(),
  phone: optionalText(30),
  photo,
  gender: z.enum(GENDERS, { error: 'must be male, female or other' })
    .or(z.literal('').transform(() => null)).nullish(),
  dateOfBirth: birthDate,
  address: optionalText(500),
  emergencyContact: optionalText(100),
};

// Membership details are no longer part of a member. A member can be created
// with a plan attached in one call, but the expiry that follows from it is the
// server's to work out — see membershipStartSchema.
export const createMemberSchema = z.object({
  ...memberBase,
  planId: uuid.optional(),
  startDate: date.optional(),
}).superRefine((data, ctx) => {
  if (data.startDate && !data.planId) {
    ctx.addIssue({
      code: 'custom', path: ['planId'],
      message: 'is required when a start date is given',
    });
  }
});

export const updateMemberSchema = z.object({
  ...memberBase,
  name: name.optional(),
});

// --- membership plans --------------------------------------------------

const planBase = {
  name,
  price: money,
  durationDays: z.coerce.number({ error: 'must be a number' })
    .int('must be a whole number')
    .min(1, 'must be at least 1 day')
    .max(3650, 'cannot be more than 10 years'),
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
  includeInactive: z.enum(['true', 'false']).optional()
    .transform(v => v === 'true'),
});

// --- memberships -------------------------------------------------------

// The client picks a plan and a start date; expiry follows from the plan's
// duration and is never accepted from the request.
export const createMembershipSchema = z.object({
  planId: uuid,
  startDate: date.optional(),
});

// --- audit logs --------------------------------------------------------

export const auditLogQuerySchema = z.object({
  entity: z.string().trim().max(40).optional(),
  actorId: uuid.optional(),
  from: date.optional(),
  to: date.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).superRefine((data, ctx) => {
  if (data.from && data.to && data.to < data.from) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'must be after the from date' });
  }
});

// --- attendance --------------------------------------------------------

export const checkinSchema = z.object({ memberId: uuid });

// --- payments ----------------------------------------------------------

export const createPaymentSchema = z.object({
  memberId: uuid,
  amount: money.refine(v => v > 0, 'must be greater than zero'),
  method: z.enum(PAYMENT_METHODS, { error: 'must be cash or online' }).optional(),
  status: z.enum(PAYMENT_STATUSES, { error: 'must be paid or due' }).optional(),
  notes: optionalText(500),
  paymentDate: date.optional(),
});

// Nothing here may be required: the page loads with no filters at all. Blank
// values are dropped rather than rejected, so an empty search box or a cleared
// date input is a no-op instead of a 400.
const blankToUndefined = z.literal('').transform(() => undefined);

export const updatePaymentSchema = z.object({
  // The member a payment belongs to is deliberately not editable — moving money
  // between members is a delete and a fresh entry, so both show in the trail.
  amount: money.refine(v => v > 0, 'must be greater than zero').optional(),
  method: z.enum(PAYMENT_METHODS, { error: 'must be cash or online' }).optional(),
  status: z.enum(PAYMENT_STATUSES, { error: 'must be paid or due' }).optional(),
  notes: optionalText(500),
  paymentDate: date.optional(),
});

export const paymentQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUSES, { error: 'must be paid or due' })
    .or(blankToUndefined).optional(),
  search: z.string().trim().max(100, 'is too long')
    .transform(v => v || undefined).optional(),
  from: date.or(blankToUndefined).optional(),
  to: date.or(blankToUndefined).optional(),
}).superRefine((data, ctx) => {
  if (data.from && data.to && data.to < data.from) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'must be after the from date' });
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
  category: z.enum(SUPPLEMENT_CATEGORIES, { error: 'is not a valid category' }),
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

// --- inferred request-body types ---------------------------------------

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
export type GoogleAuthBody = z.infer<typeof googleAuthSchema>;
export type CreateStaffBody = z.infer<typeof createStaffSchema>;
export type CreateMemberLoginBody = z.infer<typeof createMemberLoginSchema>;
export type UpdateUserBody = z.infer<typeof updateUserSchema>;
export type TransferOwnershipBody = z.infer<typeof transferOwnershipSchema>;
export type CreateMemberBody = z.infer<typeof createMemberSchema>;
export type UpdateMemberBody = z.infer<typeof updateMemberSchema>;
export type CreateMembershipPlanBody = z.infer<typeof createMembershipPlanSchema>;
export type UpdateMembershipPlanBody = z.infer<typeof updateMembershipPlanSchema>;
export type MembershipPlanQuery = z.infer<typeof membershipPlanQuerySchema>;
export type CreateMembershipBody = z.infer<typeof createMembershipSchema>;
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type CheckinBody = z.infer<typeof checkinSchema>;
export type CreatePaymentBody = z.infer<typeof createPaymentSchema>;
export type UpdatePaymentBody = z.infer<typeof updatePaymentSchema>;
export type PaymentQuery = z.infer<typeof paymentQuerySchema>;
export type CreatePlanBody = z.infer<typeof createPlanSchema>;
export type AssignPlanBody = z.infer<typeof assignPlanSchema>;
export type CreateSupplementBody = z.infer<typeof createSupplementSchema>;
export type UpdateSupplementBody = z.infer<typeof updateSupplementSchema>;
export type IdParam = z.infer<typeof idParam>;

export type Gender = (typeof GENDERS)[number];
