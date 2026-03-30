/// <reference lib="webworker" />
import { StrokeEngine }  from './stroke';
import type { BrushDescriptor } from './brush-descriptor';

const engine = new StrokeEngine();

self.onmessage = (e: MessageEvent) => {
    const msg = e.data;

    switch (msg.type) {

        case 'set_descriptor': {
            const d = msg.descriptor as BrushDescriptor;
            engine.setDescriptor(d);
            // Sync smoothing from descriptor so it doesn't need a separate message
            engine.smoothingStrength = d.smoothing ?? 0;
            break;
        }

        case 'set_pressure_lut': {
            engine.setPressureLUT(msg.lut as Float32Array);
            break;
        }

        case 'set_dynamics_luts': {
            engine.setDynamicsLUTs(msg.packed as Float32Array);
            break;
        }

        case 'set_smoothing': {
            engine.smoothingStrength = msg.strength as number;
            break;
        }

        case 'begin': {
            // No size/color in message — all in descriptor
            engine.beginStroke(
                msg.x, msg.y, msg.pressure,
                msg.tiltX ?? 0, msg.tiltY ?? 0
            );
            break;
        }

        case 'move': {
            engine.addPoint(
                msg.x, msg.y, msg.pressure,
                msg.tiltX ?? 0, msg.tiltY ?? 0
            );
            const stamps = engine.flush();
            if (stamps.length > 0) {
                self.postMessage({ type: 'stamps', data: stamps }, [stamps.buffer]);
            }
            break;
        }

        case 'predict': {
            const prediction = engine.getPredictedStamps();
            self.postMessage({ type: 'prediction', data: prediction }, [prediction.buffer]);
            break;
        }

        case 'flush_final': {
            const finalStamps = engine.flush();
            engine.endStroke();
            self.postMessage({ type: 'final', data: finalStamps }, [finalStamps.buffer]);
            break;
        }

        case 'reset': {
            engine.endStroke();
            break;
        }
    }
};
