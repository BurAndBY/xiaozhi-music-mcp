import { fetchJsonApi, textResult } from "./common";

export async function exchangeRate(currency: string): Promise<object> {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("currency must be a three-letter ISO code, for example USD");
  const data = await fetchJsonApi("https://api.exchangerate-api.com/v4/latest/USD", {}, 5_000) as { rates?: Record<string, number>; date?: string };
  const byn = data.rates?.BYN;
  const sourceRate = code === "USD" ? 1 : data.rates?.[code];
  if (!byn || !sourceRate) throw new Error(`Exchange rate unavailable for ${code}`);
  return textResult(JSON.stringify({ source: "ExchangeRate-API", currency: code, rate: byn / sourceRate, date: data.date ?? null }));
}
