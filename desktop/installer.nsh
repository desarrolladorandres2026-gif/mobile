; ZIPP · Script NSIS adicional para el instalador de Zipp Negocios.
;
; `app.setLoginItemSettings({openAtLogin:true})` (autostart.ts) escribe la
; entrada de inicio automático en el registro del USUARIO, no en algo que
; el desinstalador de electron-builder sepa limpiar por su cuenta. Sin esto,
; desinstalar deja un valor huérfano en el Run del registro que Windows
; intenta ejecutar en cada inicio de sesión y simplemente falla en
; silencio — no es un riesgo, pero sí basura que no debería quedar.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
!macroend
