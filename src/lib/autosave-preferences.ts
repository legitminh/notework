export const AUTOSAVE_SECONDS_KEY = 'notework:autosave-seconds';
export const DEFAULT_AUTOSAVE_SECONDS = 4;
export const MIN_AUTOSAVE_SECONDS = 1;

export function normalizeAutosaveSeconds(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_AUTOSAVE_SECONDS
    ? value
    : DEFAULT_AUTOSAVE_SECONDS;
}

export function readAutosaveSeconds() {
  try { return normalizeAutosaveSeconds(Number(localStorage.getItem(AUTOSAVE_SECONDS_KEY))); }
  catch { return DEFAULT_AUTOSAVE_SECONDS; }
}
