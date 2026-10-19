import { fetchJsonCached, textResult } from "./common";

type Env = { YANDEX_WEATHER_API_KEY: string };
function coords(args: Record<string, unknown>) {
  const { latitude, longitude } = args;
  if (typeof latitude !== "number" || latitude < -90 || latitude > 90) throw new Error("latitude must be between -90 and 90");
  if (typeof longitude !== "number" || longitude < -180 || longitude > 180) throw new Error("longitude must be between -180 and 180");
  return { latitude, longitude };
}
export async function weather(args: Record<string, unknown>, env: Env): Promise<object> {
  const { latitude, longitude } = coords(args);
  if (!env.YANDEX_WEATHER_API_KEY) throw new Error("YANDEX_WEATHER_API_KEY is not configured");
  const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude) });
  if (typeof args.language === "string" && args.language.trim()) params.set("lang", args.language.trim());
  if (Number.isInteger(args.limit)) params.set("limit", String(Math.max(1, Math.min(7, args.limit as number))));
  return textResult(JSON.stringify({ source: "Yandex Weather", cached_for_seconds: 1800, latitude, longitude, data: await fetchJsonCached(`https://api.weather.yandex.ru/v2/forecast?${params}`, { "X-Yandex-API-Key": env.YANDEX_WEATHER_API_KEY }, 15_000, 1800) }));
}
export async function rainForecast(args: Record<string, unknown>, env: Env): Promise<object> {
  const { latitude, longitude } = coords(args);
  if (!env.YANDEX_WEATHER_API_KEY) throw new Error("YANDEX_WEATHER_API_KEY is not configured");
  const data = await fetchJsonCached(`https://api.weather.yandex.ru/v2/forecast?lat=${latitude}&lon=${longitude}&limit=2`, { "X-Yandex-API-Key": env.YANDEX_WEATHER_API_KEY }, 15_000, 900) as { forecast?: { hours?: Array<Record<string, unknown>> } };
  const hours = (data.forecast?.hours ?? []).filter((hour) => /rain|drizzle|shower|snow/i.test(String(hour.condition ?? "")) || Number(hour.prec_prob ?? 0) > 0).slice(0, 12).map((hour) => ({ hour: hour.hour ?? null, condition: hour.condition ?? null, precipitation_probability: hour.prec_prob ?? null, precipitation_mm: hour.prec_mm ?? null }));
  return textResult(JSON.stringify({ latitude, longitude, precipitation_hours: hours, message: hours.length ? "Precipitation is expected during the listed hours." : "No precipitation is expected in the next forecast period." }));
}
