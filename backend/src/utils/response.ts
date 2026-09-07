import { Response } from 'express';

interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  meta?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export const sendResponse = <T>(
  res: Response,
  statusCode: number,
  message: string,
  data?: T,
  meta?: ApiResponse['meta']
): Response => {
  const response: ApiResponse<T> = { success: true, message };
  if (data !== undefined) response.data = data;
  if (meta) response.meta = meta;
  return res.status(statusCode).json(response);
};

export const sendError = (
  res: Response,
  statusCode: number,
  message: string
): Response => {
  return res.status(statusCode).json({ success: false, message });
};
