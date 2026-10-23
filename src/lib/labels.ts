import type { ArmId } from "../../supabase/functions/_shared/engine.ts";

export const ARM_LABEL: Record<ArmId, string> = {
  market: "Market price",
  base_rate: "Base rate",
  always_0_5: "Always 0.5",
  no_research: "No research",
  research: "Research",
};

export function formatScore(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toFixed(3);
}

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Something went wrong.";
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
