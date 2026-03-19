// src/ui/SliderGroup.ts
import { ColorState } from '../core/ColorState';

export class SliderGroup {
    private root: HTMLElement;

    constructor(private state: ColorState) {
        this.root = document.documentElement;
        this.setupListeners();
        
        // Listen to state changes to update the UI
        this.state.subscribe(() => this.updateUI());
        this.updateUI(); // Initial sync
    }

    private setupListeners() {
        const bindSlider = (id: string, setter: (val: number) => void) => {
            const el = document.getElementById(id) as HTMLInputElement;
            if (el) {
                el.addEventListener('input', (e) => {
                    setter(parseFloat((e.target as HTMLInputElement).value));
                });
            }
        };

        // Standard RGB/HSV inputs
        bindSlider('redSlider', (v) => this.state.setRgb(v, this.state.rgb.g, this.state.rgb.b));
        bindSlider('greenSlider', (v) => this.state.setRgb(this.state.rgb.r, v, this.state.rgb.b));
        bindSlider('blueSlider', (v) => this.state.setRgb(this.state.rgb.r, this.state.rgb.g, v));
        bindSlider('hueSlider', (v) => this.state.setHue(v));
        bindSlider('satSlider', (v) => this.state.setSaturation(v));
        bindSlider('valSlider', (v) => this.state.setValue(v));
    }

    private updateUI() {
        const { rgb, hsv, hex } = this.state;

        // 1. Update text values and slider thumbs
        const updateTextAndValue = (id: string, val: number | string, suffix = '') => {
            const slider = document.getElementById(id) as HTMLInputElement;
            const label = document.getElementById(id.replace('Slider', 'Val'));
            if (slider && slider.value !== String(val)) slider.value = String(val);
            if (label) label.textContent = val + suffix;
        };

        updateTextAndValue('redSlider', rgb.r);
        updateTextAndValue('greenSlider', rgb.g);
        updateTextAndValue('blueSlider', rgb.b);
        updateTextAndValue('hueSlider', hsv.h, '°');
        updateTextAndValue('satSlider', hsv.s, '%');
        updateTextAndValue('valSlider', hsv.v, '%');

        // Update swatch & hex
        const hexDisplay = document.getElementById('hexDisplay');
        const swatch = document.getElementById('colorSwatch');
        if (hexDisplay) hexDisplay.textContent = hex;
        if (swatch) swatch.style.backgroundColor = hex;

        // 2. Update CSS Variables for highly performant gradients
        this.root.style.setProperty('--red-start', `rgb(0, ${rgb.g}, ${rgb.b})`);
        this.root.style.setProperty('--red-end', `rgb(255, ${rgb.g}, ${rgb.b})`);
        
        this.root.style.setProperty('--green-start', `rgb(${rgb.r}, 0, ${rgb.b})`);
        this.root.style.setProperty('--green-end', `rgb(${rgb.r}, 255, ${rgb.b})`);
        
        this.root.style.setProperty('--blue-start', `rgb(${rgb.r}, ${rgb.g}, 0)`);
        this.root.style.setProperty('--blue-end', `rgb(${rgb.r}, ${rgb.g}, 255)`);

        // We use full opacity values for HSV gradients based on current selections
        this.root.style.setProperty('--sat-end', `hsl(${hsv.h}, 100%, 50%)`);
        this.root.style.setProperty('--val-end', `hsl(${hsv.h}, ${hsv.s}%, 50%)`);
    }
}