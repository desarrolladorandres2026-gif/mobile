import { describe, it, expect } from 'vitest';
import { isOwnStorageUrl } from '../services/driverDossierFiles';

describe('Expediente: origen permitido de archivos', () => {
  const cloud = 'zipp';
  it('acepta la entrega y la descarga privada de PDF de la cuenta propia', () => {
    expect(isOwnStorageUrl('https://res.cloudinary.com/zipp/image/authenticated/s--x--/a.jpg', cloud)).toBe(true);
    expect(isOwnStorageUrl('https://api.cloudinary.com/v1_1/zipp/raw/download?public_id=a.pdf', cloud)).toBe(true);
  });
  it('rechaza otra cuenta, otro host, http y basura', () => {
    expect(isOwnStorageUrl('https://res.cloudinary.com/otra/image/upload/a.jpg', cloud)).toBe(false);
    expect(isOwnStorageUrl('https://api.cloudinary.com/v1_1/otra/raw/download', cloud)).toBe(false);
    expect(isOwnStorageUrl('https://evil.com/zipp/a.jpg', cloud)).toBe(false);
    expect(isOwnStorageUrl('http://res.cloudinary.com/zipp/a.jpg', cloud)).toBe(false);
    expect(isOwnStorageUrl('http://169.254.169.254/latest', cloud)).toBe(false);
    expect(isOwnStorageUrl('no es url', cloud)).toBe(false);
    expect(isOwnStorageUrl('https://res.cloudinary.com/zipp/a.jpg', undefined as unknown as string)).toBe(false);
  });
});
