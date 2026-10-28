import { describe, expect, it } from 'vitest';
import { loadConfig, parseTrustProxy } from './config.js';

const PROD = { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://app.example.co', MONGODB_URI: 'mongodb://x', APP_BASE_URL: 'https://app.example.co', MFA_ENCRYPTION_KEY: 'k', SMTP_URL: 'smtp://x', MAIL_FROM: 'a@b.co', INVOICING_PROVIDER: 'real' };

describe('TRUST_PROXY', () => {
  it('sin definir o en false no confía en ningún proxy', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
  });

  it('un número es la cantidad de saltos de proxy de confianza', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
    expect(() => parseTrustProxy('-1')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('99')).toThrow(/TRUST_PROXY/);
  });

  it('una lista de direcciones o rangos CIDR se acepta; lo que no es una dirección se rechaza', () => {
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12')).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
    expect(parseTrustProxy('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(parseTrustProxy('::1')).toEqual(['::1']);
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('proxy.example.co')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('10.0.0.1,,')).not.toThrow();
  });

  it('«true» confía en cualquier cabecera X-Forwarded-For (se falsifica la IP del límite): fuera de producción pasa, en producción no arranca', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(() => loadConfig({ ...PROD, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY=true/);
    expect(loadConfig({ ...PROD, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...PROD, TRUST_PROXY: '10.0.0.0/8' }).trustProxy).toEqual(['10.0.0.0/8']);
    expect(loadConfig({ NODE_ENV: 'test' }).trustProxy).toBe(false);
  });
});
