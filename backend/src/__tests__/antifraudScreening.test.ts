import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserRole } from '../types';
import {
  FraudAlert,
  FraudAlertType,
  FraudAlertStatus,
  RiskLevel,
  antiFraudService,
} from '../security';
import { ingestPing, forgetDriver } from '../services/tracking.service';
import { makeUser, makeDriver, GARZON, offsetKm } from './factories';

/**
 * Vigilancia de las posiciones que manda el repartidor.
 *
 * Los detectores existían desde hace tiempo sin que nadie los llamara. Al
 * conectarlos, el riesgo dejó de ser que no detectaran y pasó a ser que
 * detectaran demasiado: corren en cada ping aceptado, así que un solo
 * repartidor con el GPS simulado podía abrir cientos de alertas idénticas
 * en un turno. Estas pruebas fijan las dos mitades del contrato — que
 * detecte, y que no inunde.
 */
describe('raiseAlertOnce: una alerta por problema, no por observación', () => {
  const userId = '507f1f77bcf86cd799439011';

  const signal = () => ({
    userId,
    type: FraudAlertType.MOCK_LOCATION,
    riskLevel: RiskLevel.CRITICAL,
    riskScore: 95,
    description: 'Ubicación GPS falsa detectada',
    evidence: { lat: GARZON.lat, lng: GARZON.lng },
  });

  it('abre la alerta la primera vez', async () => {
    const { alert, isNew } = await antiFraudService.raiseAlertOnce(signal());

    expect(isNew).toBe(true);
    expect(alert.occurrences).toBe(1);
    expect(alert.status).toBe(FraudAlertStatus.OPEN);
    expect(await FraudAlert.countDocuments({ userId })).toBe(1);
  });

  it('cuenta las repeticiones en la alerta abierta en vez de crear otra', async () => {
    await antiFraudService.raiseAlertOnce(signal());
    await antiFraudService.raiseAlertOnce(signal());
    const { alert, isNew } = await antiFraudService.raiseAlertOnce(signal());

    expect(isNew).toBe(false);
    expect(alert.occurrences).toBe(3);
    expect(await FraudAlert.countDocuments({ userId })).toBe(1);
  });

  it('guarda la evidencia más reciente, que es la útil para investigar', async () => {
    await antiFraudService.raiseAlertOnce(signal());
    const { alert } = await antiFraudService.raiseAlertOnce({
      ...signal(),
      evidence: { lat: 1, lng: 2, marca: 'la última' },
    });

    expect(alert.evidence).toMatchObject({ marca: 'la última' });
  });

  it('vuelve a abrir una alerta si el problema sigue después de resolverla', async () => {
    const first = await antiFraudService.raiseAlertOnce(signal());
    await FraudAlert.updateOne(
      { _id: first.alert._id },
      { status: FraudAlertStatus.RESOLVED }
    );

    const second = await antiFraudService.raiseAlertOnce(signal());

    expect(second.isNew).toBe(true);
    expect(second.alert._id).not.toEqual(first.alert._id);
    expect(await FraudAlert.countDocuments({ userId })).toBe(2);
  });

  it('separa las alertas por tipo: dos problemas distintos no se funden', async () => {
    await antiFraudService.raiseAlertOnce(signal());
    await antiFraudService.raiseAlertOnce({
      ...signal(),
      type: FraudAlertType.SUSPICIOUS_LOCATION_CHANGE,
    });

    expect(await FraudAlert.countDocuments({ userId })).toBe(2);
  });
});

describe('ingestPing: revisión antifraude de la posición', () => {
  let driverUser: any;

  beforeEach(async () => {
    driverUser = await makeUser({ role: UserRole.DRIVER });
    await makeDriver(driverUser._id);
    forgetDriver(driverUser._id.toString());
  });

  afterEach(() => {
    forgetDriver(driverUser._id.toString());
    vi.useRealTimers();
  });

  it('levanta alerta crítica cuando el dispositivo admite que simula la ubicación', async () => {
    await ingestPing(driverUser._id.toString(), {
      lat: GARZON.lat,
      lng: GARZON.lng,
      accuracy: 8,
      isMocked: true,
    });

    const alert = await FraudAlert.findOne({
      userId: driverUser._id.toString(),
      type: FraudAlertType.MOCK_LOCATION,
    });

    expect(alert).not.toBeNull();
    expect(alert!.riskLevel).toBe(RiskLevel.CRITICAL);
  });

  it('no abre una alerta por cada ping simulado: un turno entero cabe en una', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(start + i * 6000);
      await ingestPing(driverUser._id.toString(), {
        ...offsetKm(GARZON, i * 0.05),
        accuracy: 8,
        isMocked: true,
      });
    }

    const alerts = await FraudAlert.find({
      userId: driverUser._id.toString(),
      type: FraudAlertType.MOCK_LOCATION,
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].occurrences).toBe(5);
  });

  it('detecta el teletransporte entre dos posiciones aceptadas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    await ingestPing(driverUser._id.toString(), {
      ...GARZON,
      accuracy: 8,
    });

    // 6 km en 6 segundos son 3.600 km/h. Ninguna moto hace eso.
    vi.setSystemTime(start + 6000);
    await ingestPing(driverUser._id.toString(), {
      ...offsetKm(GARZON, 6),
      accuracy: 8,
    });

    const alert = await FraudAlert.findOne({
      userId: driverUser._id.toString(),
      type: FraudAlertType.SUSPICIOUS_LOCATION_CHANGE,
    });

    expect(alert).not.toBeNull();
    expect(alert!.evidence.speedKmH).toBeGreaterThan(200);
  });

  it('deja en paz a un repartidor que se mueve como un repartidor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();

    await ingestPing(driverUser._id.toString(), { ...GARZON, accuracy: 8 });

    // 60 metros en 6 segundos: 36 km/h, una moto en ciudad.
    vi.setSystemTime(start + 6000);
    await ingestPing(driverUser._id.toString(), {
      ...offsetKm(GARZON, 0.06),
      accuracy: 8,
    });

    expect(await FraudAlert.countDocuments({ userId: driverUser._id.toString() })).toBe(0);
  });

  it('no inventa spoofing cuando el teléfono no informa la precisión', async () => {
    // Sin `accuracy`, el detector no puede opinar. Antes de tenerlo en
    // cuenta, un cero fabricado convertía "no sé" en "precisión perfecta"
    // y abría una alerta de spoofing en cada ping sin ese dato.
    await ingestPing(driverUser._id.toString(), { lat: GARZON.lat, lng: GARZON.lng });

    expect(await FraudAlert.countDocuments({ userId: driverUser._id.toString() })).toBe(0);
  });
});
