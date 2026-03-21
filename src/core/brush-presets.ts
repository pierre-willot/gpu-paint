import { BrushDescriptor, defaultBrushDescriptor, cloneDescriptor, descriptorFromJSON } from '../renderer/brush-descriptor';

export interface BrushPreset {
    id:       string;
    name:     string;
    desc:     BrushDescriptor;
    builtIn:  boolean;
    category: string;   // 'Basic' | 'Painting' | 'Texture' | 'Special' | 'Custom'
}

const STORAGE_KEY = 'gpaint_brush_presets_v1';

function makeBuiltIns(): BrushPreset[] {
    const base = defaultBrushDescriptor();
    return [
        {
            id: '__soft_round', name: 'Soft Round', builtIn: true, category: 'Basic',
            desc: { ...base, hardness: 0.0, spacing: 0.25, opacity: 0.9, pressureOpacity: 0.8 },
        },
        {
            id: '__hard_round', name: 'Hard Round', builtIn: true, category: 'Basic',
            desc: { ...base, hardness: 1.0, spacing: 0.10, opacity: 1.0, pressureSize: 1.0 },
        },
        {
            id: '__pencil', name: 'Pencil', builtIn: true, category: 'Basic',
            desc: { ...base, size: 0.03, hardness: 0.85, spacing: 0.15, opacity: 0.7,
                    opacityJitter: 0.15, sizeJitter: 0.08 },
        },
        {
            id: '__marker', name: 'Marker', builtIn: true, category: 'Basic',
            desc: { ...base, hardness: 0.95, spacing: 0.05, opacity: 0.85, flow: 0.9,
                    pressureSize: 0.3, pressureOpacity: 0.0 },
        },
        {
            id: '__airbrush', name: 'Airbrush', builtIn: true, category: 'Basic',
            desc: { ...base, size: 0.08, hardness: 0.0, spacing: 0.15, opacity: 0.4,
                    flow: 0.3, pressureOpacity: 0.9 },
        },
        // ── Concept art brushes ───────────────────────────────────────────────
        {
            id: '__flat_color', name: 'Flat Color', builtIn: true, category: 'Painting',
            desc: { ...base, size: 0.08, hardness: 0.88, spacing: 0.05, opacity: 1.0,
                    pressureSize: 0.45, flow: 1.0 },
        },
        {
            id: '__soft_gradient', name: 'Soft Gradient', builtIn: true, category: 'Painting',
            desc: { ...base, size: 0.12, hardness: 0.0, spacing: 0.10, opacity: 0.6,
                    flow: 0.55, pressureOpacity: 0.9, opacityMin: 0, opacityMax: 1 },
        },
        {
            id: '__rough_chalk', name: 'Rough Chalk', builtIn: true, category: 'Texture',
            desc: { ...base, size: 0.045, hardness: 0.55, spacing: 0.18, opacity: 0.78,
                    opacityJitter: 0.32, sizeJitter: 0.14, pressureOpacity: 0.5,
                    grainIndex: 0, grainDepth: 0.42, grainScale: 1.4,
                    grainBlendMode: 'multiply' },
        },
        {
            id: '__dry_ink', name: 'Dry Ink', builtIn: true, category: 'Painting',
            desc: { ...base, size: 0.025, hardness: 0.96, spacing: 0.07, opacity: 0.92,
                    pressureSize: 0.9, followStroke: true, sizeJitter: 0.04 },
        },
        {
            id: '__scatter_spatter', name: 'Spatter', builtIn: true, category: 'Texture',
            desc: { ...base, size: 0.018, hardness: 0.78, spacing: 0.65, opacity: 0.82,
                    scatterX: 0.035, scatterY: 0.035, stampCount: 4, stampCountJitter: 2,
                    opacityJitter: 0.42, sizeJitter: 0.28, pressureSize: 0.3 },
        },
        // ── P8: Bristle ───────────────────────────────────────────────────────
        {
            id: '__fan_brush', name: 'Fan Brush', builtIn: true, category: 'Special',
            desc: { ...base, size: 0.06, hardness: 0.7, spacing: 0.12, opacity: 0.75,
                    pressureSize: 0.5, pressureOpacity: 0.4, followStroke: true,
                    bristleCount: 14, bristleLength: 1.2,
                    sizeJitter: 0.05, opacityJitter: 0.2, angleJitter: 4 },
        },
        {
            id: '__watercolor_wash', name: 'Watercolor Wash', builtIn: true, category: 'Special',
            desc: { ...base, size: 0.10, hardness: 0.0, spacing: 0.20, opacity: 0.55,
                    pressureOpacity: 0.7, flow: 0.6, wetness: 0.3, paintLoad: 0.7,
                    wetEdge: 0.65,
                    grainIndex: 5, grainDepth: 0.25, grainStatic: true, grainScale: 1.8 },
        },
    ];
}

export class BrushPresets {
    private presets: BrushPreset[] = [];

    constructor() { this.load(); }

    getAll(): BrushPreset[] { return this.presets; }

    getById(id: string): BrushPreset | undefined {
        return this.presets.find(p => p.id === id);
    }

    addCustom(name: string, desc: BrushDescriptor, category = 'Custom'): BrushPreset {
        const preset: BrushPreset = {
            id:       'custom_' + Date.now(),
            name,
            desc:     cloneDescriptor(desc),
            builtIn:  false,
            category,
        };
        this.presets.push(preset);
        this.save();
        return preset;
    }

    /** Update the stored descriptor for any preset (built-in or custom). */
    update(id: string, desc: BrushDescriptor): void {
        const p = this.presets.find(p => p.id === id);
        if (p) { p.desc = cloneDescriptor(desc); this.save(); }
    }

    updateCustom(id: string, desc: BrushDescriptor): void {
        const p = this.presets.find(p => p.id === id && !p.builtIn);
        if (p) { p.desc = cloneDescriptor(desc); this.save(); }
    }

    renameCustom(id: string, name: string): void {
        const p = this.presets.find(p => p.id === id && !p.builtIn);
        if (p) { p.name = name; this.save(); }
    }

    delete(id: string): void {
        const idx = this.presets.findIndex(p => p.id === id && !p.builtIn);
        if (idx >= 0) { this.presets.splice(idx, 1); this.save(); }
    }

    restoreDefaults(): void {
        const customs = this.presets.filter(p => !p.builtIn);
        this.presets  = [...makeBuiltIns(), ...customs];
        this.save();   // clears built-in overrides too
    }

    importFromJSON(json: string): BrushPreset | null {
        try {
            const obj  = JSON.parse(json) as Record<string, unknown>;
            const name = typeof obj['name'] === 'string' ? obj['name'] : 'Imported Brush';
            const desc = descriptorFromJSON(JSON.stringify(obj['desc'] ?? obj));
            return this.addCustom(name, desc);
        } catch { return null; }
    }

    exportPreset(id: string): string | null {
        const p = this.getById(id);
        if (!p) return null;
        const { color: _c, ...rest } = p.desc;
        return JSON.stringify({ name: p.name, desc: rest }, null, 2);
    }

    exportAll(): string {
        return JSON.stringify(this.presets.map(p => {
            const { color: _c, ...rest } = p.desc;
            return { name: p.name, desc: rest };
        }), null, 2);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private load(): void {
        const builtIns = makeBuiltIns();
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw) as {
                    customs: Array<{ id: string; name: string; desc: unknown }>;
                    builtInOverrides?: Array<{ id: string; desc: unknown }>;
                };
                // Apply saved overrides to built-in descriptors
                for (const ov of (saved.builtInOverrides ?? [])) {
                    const found = builtIns.find(b => b.id === ov.id);
                    if (found) found.desc = descriptorFromJSON(JSON.stringify(ov.desc));
                }
                const customs: BrushPreset[] = (saved.customs ?? []).map((c: any) => ({
                    id:       c.id,
                    name:     c.name,
                    desc:     descriptorFromJSON(JSON.stringify(c.desc)),
                    builtIn:  false,
                    category: c.category ?? 'Custom',
                }));
                this.presets = [...builtIns, ...customs];
                return;
            }
        } catch { /* ignore corrupt storage */ }
        this.presets = builtIns;
    }

    private save(): void {
        const customs          = this.presets.filter(p => !p.builtIn);
        const builtInOverrides = this.presets.filter(p => p.builtIn).map(p => ({ id: p.id, desc: p.desc }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ customs, builtInOverrides }));
    }
}
