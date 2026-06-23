# Solución Linux - CDP + API Antecedentes Policía

## 🧩 Problema inicial

Al intentar ejecutar la automatización en Linux, el sistema presentaba múltiples fallos:

- Chromium no iniciaba correctamente
- CDP (Chrome DevTools Protocol) no levantaba
- Error `Missing X server or $DISPLAY`
- Error `Running as root without --no-sandbox`
- Fallos de `xvfb-run` mal configurado
- Python no podía instalar dependencias (`externally-managed-environment`)

---

## 🔥 Causa raíz

El problema principal era la combinación de:

- Ejecución en entorno Linux sin display gráfico real
- Uso de Chromium como root sin configuración correcta
- Falta de X virtual server (Xvfb)
- Lanzamiento incorrecto del browser sin sandbox flags adecuados

---

## ✅ Solución implementada

### 1. Instalación de dependencias

```bash
apt update
apt install -y chromium xvfb xauth dbus-x11 python3-venv python3-full