function toTitleWords(value: string): string {
  return String(value || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.substring(1).toLowerCase())
    .join(' ');
}

export function inferEnvironmentFromUrl(url: string | null | undefined): string {
  const normalizedUrl = String(url || '').trim().toLowerCase();

  if (!normalizedUrl || normalizedUrl === '-') return '-';
  if (normalizedUrl.includes('val')) return 'Validation';
  if (normalizedUrl.includes('dev') || normalizedUrl.includes('sandbox')) return 'Staging';
  if (normalizedUrl.includes('localhost') || normalizedUrl.includes('127.0.0.1')) return 'Local';
  return 'Local';
}

export function normalizeExecutionEnvironment(environment: string | null | undefined): string {
  const normalized = String(environment || '').trim().toLowerCase();

  if (!normalized || normalized === '-') return 'local';
  if (normalized.includes('val')) return 'validation';
  if (normalized.includes('dev') || normalized.includes('sandbox') || normalized.includes('stage')) return 'staging';
  if (normalized.includes('localhost') || normalized.includes('127.0.0.1') || normalized.includes('local')) return 'local';
  if (normalized.includes('prod')) return 'local';
  return normalized;
}

function environmentKeyToLabel(key: string): string {
  switch (key) {
    case 'validation':
      return 'Validation';
    case 'staging':
      return 'Staging';
    case 'local':
      return 'Local';
    case 'production':
      return 'Local';
    default:
      return toTitleWords(key);
  }
}

export function resolveExecutionEnvironmentKey(appUrl: string | null | undefined, fallbackEnvironment: string | null | undefined): string {
  const inferredFromUrl = inferEnvironmentFromUrl(appUrl);
  if (inferredFromUrl !== '-') {
    return normalizeExecutionEnvironment(inferredFromUrl);
  }
  return normalizeExecutionEnvironment(fallbackEnvironment);
}

export function formatExecutionEnvironmentLabel(appUrl: string | null | undefined, fallbackEnvironment: string | null | undefined): string {
  const key = resolveExecutionEnvironmentKey(appUrl, fallbackEnvironment);
  return environmentKeyToLabel(key);
}
