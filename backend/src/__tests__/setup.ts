import { beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
// Imported through the barrel so this is guaranteed to be the same module
// instance the auth service uses.
import { resetBruteForce } from '../security';
import { pricingConfigService } from '../services/pricingConfig.service';

// Must be set before src/config/env is imported by anything under test, so
// the config layer takes its test branch (ephemeral secrets, no fail-fast).
process.env.NODE_ENV = 'test';

// On Windows the first mongod launch is often slow (antivirus scans the
// freshly downloaded binary), and the library's 10s default is not enough.
process.env.MONGOMS_STARTUP_TIMEOUT ??= '120000';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  // Espera a que los índices existan de verdad antes de la primera prueba.
  //
  // Mongoose los construye en segundo plano, así que una prueba que depende
  // de un índice único —el anti-duplicado de webhooks, el `orderId` único de
  // los códigos de seguridad— puede ejecutarse antes de que exista y ver
  // pasar dos escrituras que en producción chocan. Era una carrera latente:
  // fallaba o no según cuántos modelos hubiera que registrar al arrancar.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});

afterEach(async () => {
  // Wipe between tests so each one states its own preconditions.
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );

  // Brute-force counters live in module memory, not the database: without
  // this, failed-login tests lock out the shared 127.0.0.1 for later cases.
  resetBruteForce();

  // Same problem, different cache: the pricing config is memoised per
  // process, so a wiped database would otherwise leave every later test
  // pricing against a config document that no longer exists.
  pricingConfigService.invalidate();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
