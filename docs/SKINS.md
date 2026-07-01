# Skins & palettes

The orb is fully themeable. A **skin** is the orb's shape/structure (sphere style,
rings, flare, scanline); a **palette** is its colour set. They're independent —
mix any skin with any palette. Switch live from the orb's gear, by voice
("set skin to reactor", "use the ice palette"), or in config.

## Built-in skins

| id | name | look |
|---|---|---|
| `orbit` | Orbit | tilted orbital rings + travelling glints (default) |
| `halo` | Halo | one bold docked halo ring |
| `reactor` | Reactor | concentric segmented arc-reactor rings |
| `lens` | Lens | a camera-lens iris over the core |
| `holo` | Holo Dock | angular HUD corner brackets + scanline |
| `minimal` | Minimal | clean, quiet, waveform-forward |
| `nebula` | Nebula | soft dreamy bloom |
| `handoff` | Desktop Handoff | luminous core, technical rings, side waveforms |
| `spectrum` | Spectrum Grid | network orb with constellation nodes |
| `crystal` | Crystal Cage | wireframe icosahedron caging a glowing core |

## Built-in palettes

`ember` (default), `ice`, `violet`, `emerald`, `sunset`, `aurora`, `plasma`, `solar`.

Each palette is six colour **roles**, as `[r, g, b]`:

| role | used for |
|---|---|
| `core` | the central glow |
| `accent` | rings / secondary highlights |
| `hot` | the "speaking" heat / bright peaks |
| `deep` | shadowed depth |
| `line` | wireframe lines |
| `white` | specular highlights |

## Add your own — no recompile

Custom skins and palettes can be declared in your **`voxa-config.json`** under
`appearance`. They're validated and merged on launch, then appear in the picker
and respond to voice like the built-ins:

```jsonc
{
  "appearance": {
    "palettes": [
      {
        "id": "midnight", "name": "Midnight",
        "core":   [120, 160, 255], "accent": [200, 120, 255],
        "hot":    [210, 230, 255], "deep":   [20, 30, 80],
        "line":   [150, 190, 255], "white":  [240, 245, 255]
      }
    ],
    "skins": [
      {
        "id": "myskin", "name": "My Skin",
        "sphere": "wire",        // wire | soft | lens
        "ring":   "reactor",     // none | orbit | halo | reactor | spectrum
        "flare":  true,
        "scan":   true,
        "brackets": false,
        "defaultPalette": "midnight"
      }
    ]
  }
}
```

Rules (enforced on load): `id` is lowercased to `[a-z0-9_-]`; colours must be
3-element `0–255` arrays with all six roles present; `sphere`/`ring` fall back to
safe defaults if unrecognised; an `id` that collides with a built-in is ignored.

> Want a brand-new *sphere* or *ring* style (not just a new combination)? Those
> are drawn by the canvas renderer in [`packages/orb/src/js/orb.js`](../packages/orb/src/js/orb.js) —
> add a case there and a matching entry to `SKINS`/`SAFE_SKIN_RINGS` in
> [`skins.js`](../packages/orb/src/js/skins.js).
