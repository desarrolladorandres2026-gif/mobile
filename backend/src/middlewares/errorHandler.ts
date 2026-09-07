import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;
  /**
   * Etiqueta estable para que el cliente distinga *qué* falló sin leer el
   * texto. Sin esto, una app que quiera reaccionar distinto a "código ya
   * usado" y a "código incorrecto" acaba comparando mensajes en español,
   * que cambian con cualquier retoque de redacción.
   *
   * Opcional a propósito: los cientos de errores existentes siguen siendo
   * válidos y la respuesta solo la incluye cuando se define.
   */
  public code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values((err as any).errors).map((e: any) => e.message);
    return res.status(400).json({
      success: false,
      message: 'Error de validación',
      errors: messages,
    });
  }

  // Mongoose cast error
  //
  // Un id con forma inválida —o vacío— llegaba hasta aquí sin reconocerse
  // y salía como 500 "Error interno del servidor". No es un fallo del
  // servidor: es una petición mal formada, y el cliente necesita saber
  // qué campo lo está. Era exactamente lo que veía un comercio sin
  // categorías al intentar crear su primer producto.
  if (err.name === 'CastError') {
    const cast = err as any;
    return res.status(400).json({
      success: false,
      message: `El campo '${cast.path}' no tiene un formato válido`,
      errors: [{ field: cast.path, message: 'Identificador inválido' }],
    });
  }

  // Mongoose duplicate key
  if ((err as any).code === 11000) {
    const field = Object.keys((err as any).keyValue)[0];
    return res.status(409).json({
      success: false,
      message: `El campo '${field}' ya existe`,
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Token inválido' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expirado' });
  }

  console.error('❌ Error no controlado:', err);
  return res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
  });
};    
