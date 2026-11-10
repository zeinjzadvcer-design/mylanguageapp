/**
 * A whole-number setting, or its default.
 *
 * `parseInt(process.env.X ?? "30")` turns a blank value into NaN: `??` only
 * catches a variable that is missing, and the DigitalOcean console saves an
 * empty field as an empty string. Every comparison against NaN is false, so a
 * safety limit set to NaN quietly stops limiting anything. Blank and garbage
 * both mean "use the default" here.
 */
export function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}
