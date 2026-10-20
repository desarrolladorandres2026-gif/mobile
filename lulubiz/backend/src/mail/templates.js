/**
 * Textos de los correos. Los enlaces llevan el token en el fragmento (`#token=`): el navegador
 * no lo envía al servidor, así que no queda en registros de acceso ni en cabeceras `Referer`.
 */
const link = (base, path, token) => `${String(base).replace(/\/+$/, '')}${path}#token=${encodeURIComponent(token)}`;

export const templates = {
  verifyEmail({ baseUrl, token, hours }) {
    return {
      subject: 'Confirma tu correo en Lulubiz',
      text: [
        'Hola,',
        '',
        'Confirma que este correo es tuyo abriendo el siguiente enlace:',
        link(baseUrl, '/verificar-correo', token),
        '',
        `El enlace vence en ${hours} horas. Si no creaste una cuenta en Lulubiz, ignora este mensaje.`,
      ].join('\n'),
    };
  },

  passwordReset({ baseUrl, token, minutes }) {
    return {
      subject: 'Restablece tu contraseña de Lulubiz',
      text: [
        'Hola,',
        '',
        'Recibimos una solicitud para restablecer tu contraseña. Abre este enlace para elegir una nueva:',
        link(baseUrl, '/restablecer-contrasena', token),
        '',
        `El enlace vence en ${minutes} minutos y solo sirve una vez. Si no lo pediste, ignora este mensaje: tu contraseña no cambia.`,
      ].join('\n'),
    };
  },

  passwordChanged() {
    return {
      subject: 'Tu contraseña de Lulubiz cambió',
      text: [
        'Hola,',
        '',
        'La contraseña de tu cuenta se acaba de cambiar y se cerraron todas tus sesiones.',
        'Si no fuiste tú, restablécela de inmediato desde la pantalla de inicio de sesión y avisa a tu administrador.',
      ].join('\n'),
    };
  },

  invitation({ baseUrl, token, company, inviter, role, days }) {
    return {
      subject: `${inviter} te invitó a ${company} en Lulubiz`,
      text: [
        'Hola,',
        '',
        `${inviter} te invitó a la empresa ${company} en Lulubiz con el rol de ${role}.`,
        'Acepta la invitación desde este enlace:',
        link(baseUrl, '/invitacion', token),
        '',
        `La invitación vence en ${days} días. Si no esperabas este correo, ignóralo.`,
      ].join('\n'),
    };
  },
};
