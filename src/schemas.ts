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

export const MEMBERSHIP_TYPES = ['monthly', 'quarterly', 'yearly'] as const;
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

const memberBase = {
  name,
  email: z.email('must be a valid email address').max(255).toLowerCase()
    .or(z.literal('').transform(() => null)).nullish(),
  phone: optionalText(30),
  photo,
  membershipType: z.enum(MEMBERSHIP_TYPES, { error: 'must be monthly, quarterly or yearly' }).optional(),
  feeAmount: money.nullish(),
  startDate: date,
  endDate: date.optional(),
};

// endDate is derived from startDate when omitted, so only check the pair
// when the caller supplied both.
const endAfterStart = (
  data: { startDate?: Date; endDate?: Date },
  ctx: z.RefinementCtx,
): void => {
  if (data.startDate && data.endDate && data.endDate <= data.startDate) {
    ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'must be after the start date' });
  }
};

export const createMemberSchema = z.object(memberBase).superRefine(endAfterStart);

export const updateMemberSchema = z.object({
  ...memberBase,
  name: name.optional(),
  startDate: date.optional(),
}).superRefine(endAfterStart);

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

export const paymentQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUSES, { error: 'must be paid or due' }).optional(),
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
export type CheckinBody = z.infer<typeof checkinSchema>;
export type CreatePaymentBody = z.infer<typeof createPaymentSchema>;
export type PaymentQuery = z.infer<typeof paymentQuerySchema>;
export type CreatePlanBody = z.infer<typeof createPlanSchema>;
export type AssignPlanBody = z.infer<typeof assignPlanSchema>;
export type CreateSupplementBody = z.infer<typeof createSupplementSchema>;
export type UpdateSupplementBody = z.infer<typeof updateSupplementSchema>;
export type IdParam = z.infer<typeof idParam>;

export type MembershipType = (typeof MEMBERSHIP_TYPES)[number];
