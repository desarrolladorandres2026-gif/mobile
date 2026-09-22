import {
  payNativeBody,
  isReusable,
  isExpiredSelection,
  cardLabel,
  acceptsInstallments,
  installmentsOf,
  withInstallments,
  type SelectedInstrument,
} from '../lib/paymentInstrument';
import type { CheckoutConfig } from '../hooks/useApi';

const config: CheckoutConfig = {
  publicKey: 'pub_test_x',
  environment: 'test',
  acceptanceToken: 'ACEPTACION',
  personalDataAuthToken: 'DATOS',
  permalinks: {},
  returnUrl: 'https://zipp.example/pago/retorno',
  threeDs: false,
};

const fakeBrowser = () => ({ browser_language: 'es-CO', browser_tz: '300' });

const card = (save = false): SelectedInstrument => ({
  instrument: { kind: 'card_token', token: 'tok_test_1', installments: 1, save },
  label: 'Visa ···· 4242',
  icon: 'tarjeta',
});

describe('paymentInstrument', () => {
  it('manda los términos siempre y los datos personales solo al guardar', () => {
    expect(payNativeBody(card(false), config, fakeBrowser)).toEqual({
      instrument: card(false).instrument,
      acceptanceToken: 'ACEPTACION',
    });
    expect(payNativeBody(card(true), config, fakeBrowser).personalDataAuthToken).toBe('DATOS');
  });

  it('nunca manda dirección de regreso: la de PSE la fija el servidor', () => {
    const pse: SelectedInstrument = {
      instrument: { kind: 'pse', financialInstitutionCode: '1', userType: 0, userLegalIdType: 'CC', userLegalId: '123456' },
      label: 'PSE',
      icon: 'edificio',
    };
    expect(payNativeBody(pse, config, fakeBrowser)).not.toHaveProperty('redirectUrl');
  });

  describe('carriles bancarios', () => {
    const bancolombia: SelectedInstrument = {
      instrument: { kind: 'bancolombia_transfer' },
      label: 'Bancolombia',
      icon: 'edificio',
    };
    const daviplata: SelectedInstrument = {
      instrument: { kind: 'daviplata', userLegalIdType: 'CC', userLegalId: '1134568019' },
      label: 'DaviPlata',
      icon: 'celular',
    };

    it('Bancolombia viaja sin campos: ni tipo de persona, ni importe, ni dirección de regreso', () => {
      const body = payNativeBody(bancolombia, { ...config, threeDs: true }, fakeBrowser);
      expect(body).toEqual({ instrument: { kind: 'bancolombia_transfer' }, acceptanceToken: 'ACEPTACION' });
    });

    it('DaviPlata manda el documento y nada más: ni celular, ni navegador', () => {
      const body = payNativeBody(daviplata, { ...config, threeDs: true }, fakeBrowser);
      expect(body).toEqual({
        instrument: { kind: 'daviplata', userLegalIdType: 'CC', userLegalId: '1134568019' },
        acceptanceToken: 'ACEPTACION',
      });
    });

    it('los dos se pueden reintentar: no dependen de un token de un solo uso', () => {
      expect(isReusable(bancolombia)).toBe(true);
      expect(isReusable(daviplata)).toBe(true);
    });

    it('ninguno admite cuotas', () => {
      expect(acceptsInstallments(bancolombia)).toBe(false);
      expect(acceptsInstallments(daviplata)).toBe(false);
      expect(withInstallments(daviplata, 6)).toBe(daviplata);
    });
  });

  it('manda el navegador para 3DS solo con tarjeta nueva y 3DS encendido', () => {
    const on = { ...config, threeDs: true };
    expect(payNativeBody(card(), on, fakeBrowser).browserInfo).toEqual(fakeBrowser());
    expect(payNativeBody(card(), config, fakeBrowser)).not.toHaveProperty('browserInfo');
    const saved: SelectedInstrument = { instrument: { kind: 'saved_card', savedCardId: 'x' }, label: 'Visa', icon: 'tarjeta' };
    expect(payNativeBody(saved, on, fakeBrowser)).not.toHaveProperty('browserInfo');
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

describe('paymentInstrument · cuotas', () => {
  const newCard: SelectedInstrument = {
    instrument: { kind: 'card_token', token: 'tok_test_1', installments: 1 },
    label: 'Visa',
    icon: 'tarjeta',
  };
  const saved: SelectedInstrument = { instrument: { kind: 'saved_card', savedCardId: 'x' }, label: 'Visa', icon: 'tarjeta' };
  const nequi: SelectedInstrument = { instrument: { kind: 'nequi', phone: '3001234567' }, label: 'Nequi', icon: 'celular' };

  it('solo las tarjetas admiten cuotas', () => {
    expect(acceptsInstallments(newCard)).toBe(true);
    expect(acceptsInstallments(saved)).toBe(true);
    expect(acceptsInstallments(nequi)).toBe(false);
    expect(acceptsInstallments(null)).toBe(false);
  });

  it('cambia las cuotas de una tarjeta nueva o guardada', () => {
    expect(installmentsOf(withInstallments(newCard, 6))).toBe(6);
    expect(installmentsOf(withInstallments(saved, 12))).toBe(12);
    // Una guardada sin cuotas explícitas cuenta como una.
    expect(installmentsOf(saved)).toBe(1);
  });

  it('a Nequi no le inventa un campo de cuotas', () => {
    expect(withInstallments(nequi, 6)).toBe(nequi);
  });
});
