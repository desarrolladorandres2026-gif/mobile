import { payNativeBody, isReusable, isExpiredSelection, cardLabel, type SelectedInstrument } from '../lib/paymentInstrument';
import type { CheckoutConfig } from '../hooks/useApi';

const config: CheckoutConfig = {
  publicKey: 'pub_test_x',
  environment: 'test',
  acceptanceToken: 'ACEPTACION',
  personalDataAuthToken: 'DATOS',
  permalinks: {},
};

const card = (save = false): SelectedInstrument => ({
  instrument: { kind: 'card_token', token: 'tok_test_1', installments: 1, save },
  label: 'Visa ···· 4242',
  icon: 'tarjeta',
});

describe('paymentInstrument', () => {
  it('manda los términos siempre y los datos personales solo al guardar', () => {
    expect(payNativeBody(card(false), config)).toEqual({
      instrument: card(false).instrument,
      acceptanceToken: 'ACEPTACION',
    });
    expect(payNativeBody(card(true), config).personalDataAuthToken).toBe('DATOS');
  });

  it('la dirección de regreso solo viaja con PSE', () => {
    const pse: SelectedInstrument = {
      instrument: { kind: 'pse', financialInstitutionCode: '1', userType: 0, userLegalIdType: 'CC', userLegalId: '123456' },
      label: 'PSE',
      icon: 'edificio',
    };
    expect(payNativeBody(pse, config, 'zipp://payment-result').redirectUrl).toBe('zipp://payment-result');
    expect(payNativeBody(card(), config, 'zipp://payment-result')).not.toHaveProperty('redirectUrl');
  });

  it('una tarjeta recién escrita no se reutiliza tras un intento: su token es de un solo uso', () => {
    expect(isReusable(card())).toBe(false);
    expect(isReusable({ instrument: { kind: 'nequi', phone: '3001234567' }, label: 'Nequi', icon: 'celular' })).toBe(true);
    expect(isReusable({ instrument: { kind: 'saved_card', savedCardId: 'x' }, label: 'Visa', icon: 'tarjeta' })).toBe(true);
  });

  it('una selección vencida se detecta', () => {
    expect(isExpiredSelection({ ...card(), expiresAt: 1000 }, 2000)).toBe(true);
    expect(isExpiredSelection({ ...card(), expiresAt: 3000 }, 2000)).toBe(false);
    expect(isExpiredSelection(card(), 2000)).toBe(false);
  });

  it('pinta la marca con su nombre', () => {
    expect(cardLabel('MASTERCARD', '4444')).toBe('Mastercard ···· 4444');
  });
});
