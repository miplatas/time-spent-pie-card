# Time Spent Pie Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)

Tarjeta Lovelace personalizada para Home Assistant que muestra una **gráfica de pastel (doughnut)** con el tiempo acumulado —en horas— que una persona pasa en cada ubicación o manejando, basándose en el historial de la entidad `person.*`.

---

## Características

- Consulta la API de historial de HA para el rango **diario** (hoy, 00:00 → ahora) o **semanal** (lunes 00:00 → ahora).
- **Filtro de velocidad**: si `attributes.speed ≥ speed_threshold`, el intervalo se acumula en "Manejando" sin importar la zona geográfica.
- Clasifica automáticamente: `En casa`, `Manejando`, `Desconocido` y cualquier **zona personalizada** de HA.
- Se adapta al tema oscuro/claro usando variables CSS nativas de HA.
- Diseño responsivo: úsalo en grids o columnas para mostrar un miembro de la familia por tarjeta.

---

## Instalación con HACS

1. Ve a **HACS → Frontend → ⋮ → Repositorios personalizados**.
2. Agrega la URL de este repositorio y selecciona categoría **Lovelace**.
3. Instala la tarjeta y recarga la interfaz.

### Instalación manual

Copia `time-spent-pie-card.js` en `<config>/www/` y agrega el recurso en **Ajustes → Panel de control → Recursos**:

```yaml
url: /local/time-spent-pie-card.js
type: module
```

---

## Configuración YAML

```yaml
type: custom:time-spent-pie-card
entity: person.miguel           # Obligatorio — entidad person.*
name: Miguel                    # Opcional — título personalizado
time_range: daily               # Obligatorio — "daily" o "weekly"
speed_threshold: 15             # Opcional — km/h para detectar "Manejando" (default: 15)
```

### Parámetros

| Campo             | Tipo    | Obligatorio | Default | Descripción |
|-------------------|---------|-------------|---------|-------------|
| `entity`          | string  | ✅          | —       | Entidad `person.*` a monitorear |
| `name`            | string  | ❌          | `friendly_name` de la entidad | Título de la tarjeta |
| `time_range`      | string  | ✅          | —       | `daily` (hoy 00:00→ahora) o `weekly` (lunes 00:00→ahora) |
| `speed_threshold` | number  | ❌          | `15`    | Velocidad (km/h) a partir de la cual se contabiliza como "Manejando" |

---

## Ejemplo — múltiples personas en grid

```yaml
type: grid
columns: 3
square: false
cards:
  - type: custom:time-spent-pie-card
    entity: person.miguel
    time_range: weekly

  - type: custom:time-spent-pie-card
    entity: person.laura
    time_range: weekly

  - type: custom:time-spent-pie-card
    entity: person.sofia
    time_range: weekly
```

---

## Estructura del repositorio

```
.
├── time-spent-pie-card.js   # Código principal de la tarjeta
├── hacs.json                # Manifiesto HACS
└── README.md
```

---

## Notas técnicas

- La tarjeta **no requiere** sensores ni ayudantes (`helpers`) adicionales en HA; construye los acumuladores en tiempo real a partir del historial.
- Internamente usa **Chart.js 4** cargado dinámicamente desde CDN si no está disponible en la página.
- El historial se refresca **como máximo una vez por minuto** para no saturar la API.
- Los estados con `0 h` acumuladas se omiten de la gráfica y del grid de indicadores.

---

## Licencia

MIT — © miplatas / FIME-UANL
