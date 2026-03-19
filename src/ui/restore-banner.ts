// ── RestoreBanner ─────────────────────────────────────────────────────────────
// Shown on page load when a previous session is detected in IndexedDB.
// Non-blocking — the user can dismiss it or ignore it; the app is fully
// functional while it's visible.

export class RestoreBanner {
    private el: HTMLElement;

    constructor(
        private timestamp: number,
        private onRestore: () => Promise<void>,
        private onDiscard: () => Promise<void>
    ) {
        this.el = this.build();
        document.body.appendChild(this.el);

        // Fade in
        requestAnimationFrame(() => {
            this.el.style.opacity   = '1';
            this.el.style.transform = 'translateY(0)';
        });
    }

    dismiss() {
        this.el.style.opacity   = '0';
        this.el.style.transform = 'translateY(12px)';
        setTimeout(() => this.el.remove(), 300);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private build(): HTMLElement {
        const banner = document.createElement('div');

        banner.style.cssText = `
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translate(-50%, 12px);
            background: #1a1a1a;
            color: #e8e6e0;
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 10px;
            padding: 14px 18px;
            display: flex;
            align-items: center;
            gap: 16px;
            font-family: system-ui, -apple-system, sans-serif;
            font-size: 13px;
            line-height: 1.4;
            z-index: 10000;
            box-shadow: 0 4px 24px rgba(0,0,0,0.4);
            opacity: 0;
            transition: opacity 0.25s ease, transform 0.25s ease;
            pointer-events: all;
            max-width: 480px;
        `;

        const time    = new Date(this.timestamp);
        const minutes = Math.floor((Date.now() - this.timestamp) / 60_000);
        const timeStr = minutes < 1   ? 'just now'
                      : minutes < 60  ? `${minutes}m ago`
                      : minutes < 120 ? '1h ago'
                      : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        banner.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0;">
                <span style="font-weight:500;color:#fff">Unsaved session found</span>
                <span style="color:#888;font-size:12px">Last saved ${timeStr}</span>
            </div>
            <button id="restore-btn" style="
                padding: 7px 14px;
                background: #fff;
                color: #111;
                border: none;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                white-space: nowrap;
                font-family: inherit;
            ">Restore</button>
            <button id="discard-btn" style="
                padding: 7px 14px;
                background: transparent;
                color: #888;
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 6px;
                font-size: 13px;
                cursor: pointer;
                white-space: nowrap;
                font-family: inherit;
            ">Start fresh</button>
            <button id="banner-close" style="
                background: transparent;
                border: none;
                color: #666;
                cursor: pointer;
                font-size: 18px;
                line-height: 1;
                padding: 2px 4px;
                font-family: inherit;
            ">×</button>
        `;

        banner.querySelector('#restore-btn')!.addEventListener('click', async () => {
            this.setLoading(true, 'Restoring…');
            try {
                await this.onRestore();
                this.dismiss();
            } catch (err) {
                this.setError('Restore failed — starting fresh');
                setTimeout(() => this.dismiss(), 2500);
            }
        });

        banner.querySelector('#discard-btn')!.addEventListener('click', async () => {
            this.setLoading(true, 'Clearing…');
            await this.onDiscard();
            this.dismiss();
        });

        banner.querySelector('#banner-close')!.addEventListener('click', () => {
            this.dismiss();
        });

        return banner;
    }

    private setLoading(on: boolean, text: string) {
        const restore = this.el.querySelector('#restore-btn') as HTMLButtonElement;
        const discard = this.el.querySelector('#discard-btn') as HTMLButtonElement;
        restore.disabled = on;
        discard.disabled = on;
        if (on) restore.textContent = text;
    }

    private setError(text: string) {
        const restore = this.el.querySelector('#restore-btn') as HTMLButtonElement;
        restore.disabled    = false;
        restore.textContent = text;
        restore.style.background = '#c0392b';
        restore.style.color      = '#fff';
    }
}
