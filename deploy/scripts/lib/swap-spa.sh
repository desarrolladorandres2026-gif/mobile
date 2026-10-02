#!/usr/bin/env bash
# ZIPP · Sustituye el contenido de la raíz de un SPA sin dejar huecos
#
#   bash swap-spa.sh <dir_con_el_build_nuevo> <raiz_de_nginx>
#
# Lo usan publish-from-local.sh (por SSH) y deploy.sh (en el propio VPS).
#
# Por qué no basta con borrar y copiar: el panel de comercios queda abierto
# 24/7 (y en la app de escritorio, sin que nadie lo recargue). Un `rm -rf`
# deja un instante sin index.html y, peor, borra los chunks del build que
# esas pestañas siguen pidiendo al navegar: "Failed to fetch dynamically
# imported module" en cada deploy. El orden de abajo evita las dos cosas:
#
#   1. Llegan los archivos nuevos SIN borrar nada (los assets llevan hash,
#      así que no pisan a los viejos).
#   2. index.html se cambia con un `mv` atómico: o se sirve el viejo o el
#      nuevo, nunca uno a medio escribir.
#   3. version.json va DESPUÉS de index.html. Si fuera antes, una pestaña
#      podría ver el buildId nuevo, recargar, recibir el index viejo y
#      quedarse con el id nuevo como línea base: no volvería a enterarse
#      hasta el siguiente deploy.
#   4. Se borra lo que el build nuevo ya no trae, salvo assets/.
#   5. De assets/ se conservan los del build nuevo y los del anterior (el
#      que siguen usando las pestañas abiertas hasta que recarguen); lo más
#      viejo se borra. La lista del build vigente queda en .assets-current
#      para que el siguiente deploy sepa cuál era "el anterior". Se lleva
#      la cuenta por lista y no por fecha: con fechas, un panel que no se
#      despliega en una semana perdería los chunks del build en uso.

set -euo pipefail

src="${1:?falta el dir con el build nuevo}"
root="${2:?falta la raíz de nginx}"
LIST=.assets-current

[[ -f "$src/index.html" ]] || { echo "✗ $src no tiene index.html" >&2; exit 1; }
mkdir -p "$root"

# 1
rsync -a --chmod=a+rX --exclude=/index.html --exclude=/version.json "$src/" "$root/"

# 2
cp "$src/index.html" "$root/.index.html.tmp"
chmod a+r "$root/.index.html.tmp"
mv -f "$root/.index.html.tmp" "$root/index.html"

# 3
if [[ -f "$src/version.json" ]]; then
  cp "$src/version.json" "$root/.version.json.tmp"
  chmod a+r "$root/.version.json.tmp"
  mv -f "$root/.version.json.tmp" "$root/version.json"
fi

# 4
rsync -a --delete \
  --exclude=/assets/ --exclude=/index.html --exclude=/version.json --exclude="/$LIST" \
  "$src/" "$root/"

# 5
list_assets() { (cd "$1" && find assets -type f 2>/dev/null | LC_ALL=C sort) || true; }

list_assets "$src" > "$root/.assets-new"
if [[ -f "$root/$LIST" ]]; then
  cp "$root/$LIST" "$root/.assets-prev"
else
  # Primer deploy con este script: no se sabe qué build está en uso, así
  # que se conserva todo lo que ya había. Desde el siguiente, solo dos.
  list_assets "$root" > "$root/.assets-prev"
fi
LC_ALL=C sort -u "$root/.assets-new" "$root/.assets-prev" > "$root/.assets-keep"
list_assets "$root" | LC_ALL=C comm -23 - "$root/.assets-keep" \
  | while IFS= read -r stale; do rm -f -- "$root/$stale"; done

mv -f "$root/.assets-new" "$root/$LIST"
chmod a+r "$root/$LIST"
rm -f "$root/.assets-prev" "$root/.assets-keep"
