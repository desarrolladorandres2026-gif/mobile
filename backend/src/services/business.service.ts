import { Business, IBusiness } from '../models';
import { AppError } from '../middlewares';
import mongoose from 'mongoose';

interface CreateBusinessInput {
  ownerId: string;
  name: string;
  description?: string;
  category: string;
  address: string;
  longitude: number;
  latitude: number;
  phone: string;
  deliveryTime?: number;
  minOrder?: number;
  city?: string;
}

/** Commercial terms only an admin may set. */
export interface BusinessTermsInput {
  commissionRateBps?: number;
  isFeatured?: boolean;
  isApproved?: boolean;
  isActive?: boolean;
  minOrder?: number;
}

export class BusinessService {
  /**
   * Registers a business.
   *
   * Commercial terms are never taken from the payload: a new business
   * inherits the platform commission (`commissionRateBps: -1` means "no
   * override") and starts unapproved, so it does not appear to customers
   * until an admin reviews it. Self-registration at 0% commission and
   * self-featuring were both possible before and both leaked revenue.
   */
  async create(input: CreateBusinessInput): Promise<IBusiness> {
    const business = await Business.create({
      ...input,
      commissionRateBps: -1,
      isApproved: false,
      isFeatured: false,
      location: {
        type: 'Point',
        coordinates: [input.longitude, input.latitude],
      },
    });
    return business;
  }

  /** Admin-only: sets commission, approval and merchandising. */
  async updateTerms(id: string, terms: BusinessTermsInput): Promise<IBusiness> {
    const business = await Business.findById(id);
    if (!business) throw new AppError('Negocio no encontrado', 404);

    if (terms.commissionRateBps !== undefined) {
      business.commissionRateBps = terms.commissionRateBps;
    }
    if (terms.isFeatured !== undefined) business.isFeatured = terms.isFeatured;
    if (terms.isActive !== undefined) business.isActive = terms.isActive;
    if (terms.minOrder !== undefined) business.minOrder = terms.minOrder;
    if (terms.isApproved !== undefined) {
      business.isApproved = terms.isApproved;
      business.approvedAt = terms.isApproved ? new Date() : null;
    }

    await business.save();
    return business;
  }

  async getAll(query: {
    city?: string;
    category?: string;
    featured?: boolean;
    search?: string;
    lat?: number;
    lng?: number;
    maxDistance?: number;
    page?: number;
    limit?: number;
    includeInactive?: boolean;
  }) {
    const {
      city = 'Garzón',
      category,
      featured,
      search,
      lat,
      lng,
      maxDistance = 10000,
      page = 1,
      limit = 20,
      includeInactive,
    } = query;

    const skip = (page - 1) * limit;

    // Geospatial queries with $near don't support countDocuments — use $geoWithin + aggregation
    if (lat && lng) {
      const geoMatch: Record<string, unknown> = {
        location: {
          $geoWithin: {
            $centerSphere: [[lng, lat], maxDistance / 6378100],
          },
        },
      };

      // Unapproved businesses are invisible to customers. Approval is what
      // fixes the commercial terms, so selling through one before an admin
      // has agreed them would mean taking orders with no agreed commission.
      if (!includeInactive) {
        geoMatch.isActive = true;
        geoMatch.isApproved = true;
      }
      if (category) geoMatch.category = category;
      if (featured) geoMatch.isFeatured = true;
      if (search) geoMatch.name = { $regex: search, $options: 'i' };
      if (city) geoMatch.city = city;

      const pipeline: mongoose.PipelineStage[] = [
        { $match: geoMatch },
        {
          $facet: {
            businesses: [
              { $sort: { isFeatured: -1, rating: -1 } },
              { $skip: skip },
              { $limit: limit },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ];

      const [result] = await Business.aggregate(pipeline);
      const businesses = result.businesses as IBusiness[];
      const total = result.total[0]?.count || 0;

      return {
        businesses,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }

    // Non-geospatial path (no lat/lng provided)
    const filter: Record<string, unknown> = { city };
    if (!includeInactive) {
      filter.isActive = true;
      filter.isApproved = true;
    }
    if (category) filter.category = category;
    if (featured) filter.isFeatured = true;
    if (search) filter.name = { $regex: search, $options: 'i' };

    const [businesses, total] = await Promise.all([
      Business.find(filter).skip(skip).limit(limit).sort({ isFeatured: -1, rating: -1 }),
      Business.countDocuments(filter),
    ]);

    return {
      businesses,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getById(id: string): Promise<IBusiness> {
    const business = await Business.findById(id)
      .populate('products');
    if (!business) throw new AppError('Negocio no encontrado', 404);
    return business;
  }

  async getBySlug(slug: string): Promise<IBusiness> {
    const business = await Business.findOne({ slug })
      .populate('products');
    if (!business) throw new AppError('Negocio no encontrado', 404);
    return business;
  }

  /**
   * Updates the operational profile of a business.
   *
   * Commercial terms cannot arrive here: the validator strips them and this
   * method deletes them defensively, so neither a crafted request nor a
   * future schema slip can let a merchant reprice itself.
   */
  async update(id: string, ownerId: string, data: Partial<CreateBusinessInput>, isAdmin = false): Promise<IBusiness> {
    const business = await Business.findById(id);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    if (!isAdmin && business.ownerId.toString() !== ownerId) throw new AppError('No autorizado', 403);

    const payload = { ...data } as Record<string, unknown>;
    for (const forbidden of [
      'commissionRate',
      'commissionRateBps',
      'isFeatured',
      'isApproved',
      'approvedAt',
      'approvedBy',
      'ownerId',
      'rating',
      'totalReviews',
    ]) {
      delete payload[forbidden];
    }

    if (payload.longitude !== undefined && payload.latitude !== undefined) {
      payload.location = {
        type: 'Point',
        coordinates: [payload.longitude, payload.latitude],
      };
      delete payload.longitude;
      delete payload.latitude;
    }

    Object.assign(business, payload);
    await business.save();
    return business;
  }

  async delete(id: string, ownerId: string, isAdmin = false): Promise<void> {
    const business = await Business.findById(id);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    if (!isAdmin && business.ownerId.toString() !== ownerId) throw new AppError('No autorizado', 403);
    await Business.findByIdAndDelete(id);
  }

  async getByOwner(ownerId: string): Promise<IBusiness[]> {
    return Business.find({ ownerId }).sort({ createdAt: -1 });
  }

  // Check if business is currently open based on schedule
  isCurrentlyOpen(business: IBusiness): boolean {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
    const now = new Date();
    const dayName = days[now.getDay()];
    const schedule = business.schedule?.[dayName];
    if (!schedule || !schedule.isOpen) return false;

    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return currentTime >= schedule.open && currentTime <= schedule.close;
  }
}

export const businessService = new BusinessService();
