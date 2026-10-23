export type PublicConfig = {
  url: string;
  anonKey: string;
};

export function readPublicConfig(): PublicConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? "";
  if (url === "" || anonKey === "") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { url: url.replace(/\/$/, ""), anonKey };
}
