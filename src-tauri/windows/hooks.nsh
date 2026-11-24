; La app se llamaba «Folio»: al instalar Overfree (también desde la actualización automática)
; se desinstala en silencio la copia antigua para que no queden dos apps ni dos accesos directos.
; Sin /UPDATE para que borre sus accesos directos; en modo silencioso no toca los datos
; (la casilla «borrar datos» queda sin marcar) y los proyectos siguen en Documentos\Folio.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Folio" "UninstallString"
  ${If} $R9 != ""
    ExecWait '$R9 /S'
  ${EndIf}
!macroend
