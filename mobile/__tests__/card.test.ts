import {
  detectBrand,
  formatCardNumber,
  passesLuhn,
  formatExpiry,
  parseExpiry,
  isExpired,
  validateCardForm,
  cvcLengthFor,
} from '../lib/card';

describe('card · marca por BIN', () => {
  it.each([
    ['4242424242424242', 'VISA'],
    ['5555555555554444', 'MASTERCARD'],
    ['2223003122003222', 'MASTERCARD'],
    ['378282246310005', 'AMEX'],
    ['36227206271667', 'DINERS'],
    ['9999', 'UNKNOWN'],
  ])('%s → %s', (number, brand) => {
    expect(detectBrand(number)).toBe(brand);
  });

  it('American Express pide 4 dígitos de seguridad, el resto 3', () => {
    expect(cvcLengthFor('AMEX')).toBe(4);
    expect(cvcLengthFor('VISA')).toBe(3);
  });
});

describe('card · formato', () => {
  it('agrupa de a cuatro y recorta lo que sobra', () => {
    expect(formatCardNumber('42424242424242421234')).toBe('4242 4242 4242 4242 123');
    expect(formatCardNumber('5555-5555 5555x4444')).toBe('5555 5555 5555 4444');
  });

  it('agrupa American Express como viene en el plástico: 4-6-5', () => {
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005');
  });

  it('el vencimiento se escribe solo con barra', () => {
    expect(formatExpiry('0')).toBe('0');
    expect(formatExpiry('082')).toBe('08/2');
    expect(formatExpiry('08/29')).toBe('08/29');
  });

  it('solo acepta meses reales', () => {
    expect(parseExpiry('0829')).toEqual({ month: '08', year: '29' });
    expect(parseExpiry('1329')).toBeNull();
    expect(parseExpiry('0029')).toBeNull();
    expect(parseExpiry('08/2')).toBeNull();
  });
});

describe('card · validación', () => {
  const now = new Date(2026, 8, 17); // 17 sep 2026

  it('Luhn atrapa un dígito mal copiado', () => {
    expect(passesLuhn('4242424242424242')).toBe(true);
    expect(passesLuhn('4242424242424241')).toBe(false);
  });

  it('una tarjeta vale hasta el último día de su mes de vencimiento', () => {
    expect(isExpired('09', '26', now)).toBe(false);
    expect(isExpired('08', '26', now)).toBe(true);
    expect(isExpired('09', '26', new Date(2026, 8, 30, 23, 0))).toBe(false);
    expect(isExpired('09', '26', new Date(2026, 9, 1))).toBe(true);
  });

  it('una tarjeta de prueba correcta no tiene errores', () => {
    expect(
      validateCardForm({ number: '4242 4242 4242 4242', expiry: '12/29', cvc: '123', holder: 'Ana Pérez' }, now)
    ).toEqual({});
  });

  it('explica cada campo con un texto que se entiende', () => {
    const errors = validateCardForm({ number: '4242 4242', expiry: '08/26', cvc: '12', holder: '' }, now);
    expect(errors.number).toMatch(/número/);
    expect(errors.expiry).toMatch(/venció/);
    expect(errors.cvc).toMatch(/3 dígitos/);
    expect(errors.holder).toMatch(/nombre/);
  });

  it('en American Express el mensaje del código habla de 4 dígitos', () => {
    const errors = validateCardForm({ number: '378282246310005', expiry: '12/29', cvc: '123', holder: 'Ana' }, now);
    expect(errors.cvc).toMatch(/4 dígitos/);
  });
});
