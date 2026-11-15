export function readParam(
    source: unknown,
    name: string,
): string | undefined | null {
    if (typeof source !== 'object' || !source) return null;
    if (Array.isArray(source)) return null;
    if (!Object.hasOwn(source, name)) return undefined;

    const value = (source as Record<string, unknown>)[name];
    if (typeof value !== 'string') return null;
    if (!value) return undefined;
    return value;
}
