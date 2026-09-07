import { z } from 'zod';

/**
 * Merchant-facing schemas.
 *
 * Commercial terms are deliberately absent: `commissionRate`,
 * `commissionRateBps`, `isFeatured` and `isApproved` are not here, and the
 * validate middleware replaces the body with the parsed result, so those
 * keys are stripped rather than merely ignored. A merchant used to be able
 * to register itself at 0% commission and mark itself featured; both were
 * straight revenue holes.
 *
 * Admins set those fields through the dedicated admin endpoints, which are
 * audited.
 */
const merchantEditableFields = {
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  category: z.enum(['restaurant', 'fast_food', 'pharmacy', 'cafe', 'supermarket']),
  address: z.string().min(5),
  longitude: z.number(),
  latitude: z.number(),
  phone: z.string().min(7),
  deliveryTime: z.number().min(5).max(120).optional(),
  minOrder: z.number().min(0).optional(),
};

export const createBusinessSchema = z.object({
  body: z
    .object({
      ...merchantEditableFields,
      /** Admins may create a business on behalf of an owner. Ignored otherwise. */
      ownerId: z.string().optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

export const updateBusinessSchema = z.object({
  body: z
    .object({
      name: merchantEditableFields.name.optional(),
      description: merchantEditableFields.description,
      category: merchantEditableFields.category.optional(),
      address: merchantEditableFields.address.optional(),
      longitude: merchantEditableFields.longitude.optional(),
      latitude: merchantEditableFields.latitude.optional(),
      phone: merchantEditableFields.phone.optional(),
      deliveryTime: merchantEditableFields.deliveryTime,
      minOrder: merchantEditableFields.minOrder,
      /** Merchants may pause themselves; they may not switch themselves live. */
      isActive: z.boolean().optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});

/** Commercial terms. Admin-only, never reachable from the merchant panel. */
export const adminBusinessTermsSchema = z.object({
  body: z
    .object({
      commissionRateBps: z.number().int().min(-1).max(10_000).optional(),
      isFeatured: z.boolean().optional(),
      isApproved: z.boolean().optional(),
      isActive: z.boolean().optional(),
      minOrder: z.number().int().min(0).optional(),
    })
    .strict(),
  query: z.object({}).optional(),
  params: z.object({ id: z.string() }),
});
