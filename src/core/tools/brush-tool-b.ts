import { BrushTool }              from './brush-tool';
import { defaultBrushDescriptor } from '../../renderer/brush-descriptor';

/**
 * Engine B brush — identical rendering behaviour to BrushTool but a distinct
 * class name (so `activeToolName === 'BrushToolB'`) and different defaults.
 *
 * The UI only exposes a focused subset:
 *   size pressure · spacing · opacity · density (flow) ·
 *   primary texture (tip) · secondary texture / grain · smudge (mix)
 *
 * All other descriptor fields are kept at their defaults and never mutated
 * from the Engine B UI, so they simply have no effect.
 */
export class BrushToolB extends BrushTool {
    constructor() {
        super();
        this.loadDescriptor({
            ...defaultBrushDescriptor(),
            pressureSize: 0.5,   // pressure-to-size on by default
            spacing:      0.10,
            opacity:      1.0,
            flow:         1.0,
            smudge:       0.0,
        });
    }
}
