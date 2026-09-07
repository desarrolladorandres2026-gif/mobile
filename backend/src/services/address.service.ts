import { Address, IAddress } from '../models/Address';
import { AppError } from '../middlewares';
import { isValidCoordinate } from '../utils';

export class AddressService {
  async getAll(userId: string): Promise<IAddress[]> {
    return Address.find({ userId }).sort({ isDefault: -1, createdAt: -1 });
  }

  async create(
    userId: string,
    data: {
      label: string;
      address: string;
      details?: string;
      longitude?: number;
      latitude?: number;
      isDefault?: boolean;
    }
  ): Promise<IAddress> {
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);

    // Coordinates are not optional: they decide the delivery fee and where
    // the driver actually goes. Defaulting them to the city centre produced
    // orders addressed to a place nobody ordered from.
    if (!isValidCoordinate(latitude, longitude)) {
      throw new AppError(
        'La dirección necesita una ubicación válida. Selecciónala en el mapa o usa tu ubicación actual.',
        400
      );
    }

    const isFirstAddress = (await Address.countDocuments({ userId })) === 0;

    const isDefault = data.isDefault || isFirstAddress;

    if (isDefault) {
      // Clear default flag on existing addresses for this user
      await Address.updateMany({ userId }, { isDefault: false });
    }

    const coordinates = [longitude, latitude];

    const address = await Address.create({
      userId,
      label: data.label,
      address: data.address,
      details: data.details || '',
      location: {
        type: 'Point',
        coordinates,
      },
      isDefault,
    });

    return address;
  }

  async delete(userId: string, id: string): Promise<void> {
    const addressToDelete = await Address.findOne({ _id: id, userId });
    if (!addressToDelete) {
      throw new AppError('Dirección no encontrada', 404);
    }

    const wasDefault = addressToDelete.isDefault;
    await addressToDelete.deleteOne();

    if (wasDefault) {
      // Select another address as default
      const nextDefault = await Address.findOne({ userId }).sort({ createdAt: -1 });
      if (nextDefault) {
        nextDefault.isDefault = true;
        await nextDefault.save();
      }
    }
  }

  async setDefault(userId: string, id: string): Promise<IAddress> {
    const address = await Address.findOne({ _id: id, userId });
    if (!address) {
      throw new AppError('Dirección no encontrada', 404);
    }

    await Address.updateMany({ userId }, { isDefault: false });
    address.isDefault = true;
    await address.save();

    return address;
  }
}

export const addressService = new AddressService();
