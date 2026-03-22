import { LayerState } from "../renderer/layer-manager";

// ── SaveStatus ────────────────────────────────────────────────────────────────
// Defined here so toolbar-ui.ts and autosave-manager.ts can both import it
// without a cross-layer dependency.

export type SaveStatus =
    | { type: 'idle'                    }
    | { type: 'saving'                  }
    | { type: 'saved';  at: number      }   // Date.now() of last successful save
    | { type: 'error';  message: string };

// ── Event map ─────────────────────────────────────────────────────────────────

export interface AppEventMap {
    'history:change': {
        canUndo: boolean;
        canRedo: boolean;
    };

    'layer:change': {
        layers:      LayerState[];
        activeIndex: number;
    };

    'tool:change': {
        tool: string;
    };

    'brush:change': {
        size:  number;
        color: number[];
    };

    'color:change': {
        rgb: { r: number; g: number; b: number };
        hsv: { h: number; s: number; v: number };
        hex: string;
    };

    // Save status — subscribed by ToolbarUI to update the save indicator
    'save:status': SaveStatus;

    // Transform mode active/inactive
    'transform:change': { active: boolean };

    // Brush engine A/B toggle
    'brush:engine': { engine: 'a' | 'b' };
}

export type AppEventName    = keyof AppEventMap;
export type AppEventPayload<K extends AppEventName> = AppEventMap[K];
type Handler<K extends AppEventName> = (payload: AppEventPayload<K>) => void;

// ── EventBus ──────────────────────────────────────────────────────────────────

export class EventBus {
    private listeners = new Map<AppEventName, Set<Handler<any>>>();

    public on<K extends AppEventName>(event: K, handler: Handler<K>): () => void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(handler);
        return () => this.off(event, handler);
    }

    public off<K extends AppEventName>(event: K, handler: Handler<K>): void {
        this.listeners.get(event)?.delete(handler);
    }

    public emit<K extends AppEventName>(event: K, payload: AppEventPayload<K>): void {
        this.listeners.get(event)?.forEach(h => h(payload));
    }

    public clear(): void {
        this.listeners.clear();
    }
}
