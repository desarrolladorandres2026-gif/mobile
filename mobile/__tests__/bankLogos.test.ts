import { bankLogoKey } from '../lib/bankLogos';

// Nombres tal como los devuelve hoy GET /pse/financial_institutions de Wompi.
describe('bankLogoKey', () => {
  it.each([
    ['ACCION FIDUCIARIA', 'accion'],
    ['BAN100', 'ban100'],
    ['BANCO BBVA COLOMBIA S.A.', 'bbva'],
    ['BANCO DAVIVIENDA', 'davivienda'],
    ['DAVIbank S.A.', 'davibank'],
    ['DAVIPLATA', 'daviplata'],
    ['BANCO DE BOGOTA', 'bogota'],
    ['BANCO FALABELLA ', 'falabella'],
    ['BANCO ITAU', 'itau'],
    ['BANCO J.P. MORGAN COLOMBIA S.A.', 'jpmorgan'],
    ['BANCOOMEVA S.A.', 'bancoomeva'],
    ['CITIBANK ', 'citibank'],
    ['FINANCIERA JURISCOOP SA COMPAÑÍA DE FINANCIAMIENTO', 'juriscoop'],
    ['GLOBAL66', 'global66'],
    ['NEQUI', 'nequi'],
    ['NU', 'nu'],
    ['RAPPIPAY', 'rappipay'],
    ['UALÁ', 'uala'],
  ])('%s → %s', (name, key) => {
    expect(bankLogoKey(name)).toBe(key);
  });

  it('lo que no tiene logo propio cae en el de PSE', () => {
    expect(bankLogoKey('BANCAMIA S.A.')).toBe('pse');
    expect(bankLogoKey('BANCO UNION')).toBe('pse');
    expect(bankLogoKey('BANCO GNB SUDAMERIS')).toBe('pse');
    expect(bankLogoKey('DALE')).toBe('pse');
  });
});
