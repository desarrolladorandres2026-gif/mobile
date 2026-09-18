import mongoose from 'mongoose';
import { config } from './env';

export const connectDB = async (): Promise<void> => {
  try {
    // Sin `maxPoolSize` explícito, el driver usa su default (100) por
    // proceso. A escala, con varias instancias del backend detrás de un
    // balanceador, ese techo silencioso aparece como timeouts/lentitud
    // bajo carga sin ningún error que lo señale directamente.
    const conn = await mongoose.connect(config.mongodb.uri, {
      maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE || '200', 10),
    });
    console.log(`✅ MongoDB conectado: ${conn.connection.host}`);
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  console.log('⚠️  MongoDB desconectado');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ Error en MongoDB:', err);
});
