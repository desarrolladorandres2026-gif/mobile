/** Lo que se escribe como código de centro de costo: mayúsculas, solo letras, números, guion y guion bajo, hasta 10. */
export const normalizeCenterCode = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').replace(/^[_-]+/, '').slice(0, 10);
