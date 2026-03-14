export interface ViewState {
    x: number;
    y: number;
    zoom: number;
}
export declare class NavigationManager {
    state: ViewState;
    keys: {
        Space: boolean;
        Control: boolean;
    };
    private canvas;
    private onUpdate;
    constructor(canvas: HTMLCanvasElement, onUpdate: () => void);
    get isNavigating(): boolean;
    private initListeners;
}
//# sourceMappingURL=navigation.d.ts.map