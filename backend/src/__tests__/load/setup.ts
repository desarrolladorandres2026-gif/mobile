import { beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * Arranque de la prueba de carga.
 *
 * Es casi el de la suite normal con una diferencia que lo cambia todo: **no
 * borra las colecciones entre pruebas**. La suite normal lo hace para que
 * cada caso declare sus propias condiciones, y eso está bien cuando cada
 * caso es independiente.
 *
 * Aquí no lo son. La población de siete mil usuarios se monta una vez y
 * cada prueba trabaja sobre el estado que dejó la anterior — pedidos que se
 * crean, se reparten, se entregan y se liquidan. Borrar en medio no sería
 * aislar: sería que la mitad de los invariantes no tengan nada que
 * comprobar.
 */

process.env.NODE_ENV = 'test';

// En Windows el primer arranque de mongod es lento porque el antivirus
// escanea el binario recién descargado.
process.env.MONGOMS_STARTUP_TIMEOUT ??= '120000';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), {
    // El pool por defecto (100) se queda corto con tandas de más de cien
    // operaciones simultáneas: las que no caben esperan turno y la prueba
    // deja de medir concurrencia para medir la cola del driver.
    maxPoolSize: 200,
  });

  // Los índices tienen que existir antes de la primera escritura. En una
  // prueba de carrera esto no es cosmético: la mitad de lo que se comprueba
  // aquí —un solo payout por pedido, un solo asiento de creación, un
  // teléfono único— lo garantiza un índice único, y si todavía no se ha
  // construido, las dos escrituras pasan.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
