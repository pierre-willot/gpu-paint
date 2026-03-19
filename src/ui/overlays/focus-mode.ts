// src/ui/overlays/focus-mode.ts
// Toggles focus mode by adding/removing body.focus-mode class.
// CSS handles all the hiding — no inline style manipulation.

export class FocusMode {
    private active = false;

    constructor(private onToggle?: (active: boolean) => void) {
        // Wire the floating exit button
        document.getElementById('focusExitBtn')
            ?.addEventListener('click', () => this.toggle());

        window.addEventListener('keydown', (e) => {
            const target = e.target as HTMLElement;
            if (target.isContentEditable ||
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA') return;

            if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                e.preventDefault();
                this.toggle();
            }
        });
    }

    public toggle(): void {
        this.active = !this.active;
        document.body.classList.toggle('focus-mode', this.active);
        this.onToggle?.(this.active);
    }

    public get isActive(): boolean { return this.active; }
}
