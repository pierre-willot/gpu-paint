// ── dom.ts ────────────────────────────────────────────────────────────────────
// Single place for typed, validated DOM queries.
// Eliminates the class of null-crash bugs that plagued every UI class.

/**
 * Returns a required DOM element by ID.
 *
 * In development (import.meta.env.DEV):
 *   Throws immediately with a clear message identifying the missing ID.
 *   This surfaces HTML/ID mismatches during development, not at runtime.
 *
 * In production:
 *   Logs a warning and returns null. The caller must handle null gracefully,
 *   but the app continues running rather than crashing.
 */
export function getElement<T extends HTMLElement = HTMLElement>(
    id: string
): T | null {
    const el = document.getElementById(id) as T | null;

    if (!el) {
        const msg = `[DOM] Required element #${id} not found in the document.`;
        if (import.meta.env.DEV) {
            throw new Error(msg);
        } else {
            console.warn(msg);
        }
    }

    return el;
}

/**
 * Variant that always returns a non-null element.
 * Use only when the element is guaranteed to exist (static HTML shell).
 * Throws in both dev and production if missing.
 */
export function requireElement<T extends HTMLElement = HTMLElement>(
    id: string
): T {
    const el = document.getElementById(id) as T | null;
    if (!el) throw new Error(`[DOM] Required element #${id} not found.`);
    return el;
}

/**
 * Type-safe query on a parent element.
 */
export function queryElement<T extends HTMLElement = HTMLElement>(
    parent: HTMLElement,
    selector: string
): T | null {
    return parent.querySelector<T>(selector);
}
