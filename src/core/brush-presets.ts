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
            desc: { ...base, hardness: 0.0, spacing: 0.05, opacity: 0.9, pressureOpacity: 0.8 },
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
