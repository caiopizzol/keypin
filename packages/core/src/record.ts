export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseObject(text: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

export function objectField(data: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = data[field];
  return isRecord(value) ? value : {};
}
