// Pure field mapping between Shadow Accountant clients and HubSpot Deals (spec: specs/hubspot-sync-v2.md).
//
// A deal is an ACTIVE VA client when it is in the Virtual Accounting pipeline, has entered Payment Done at least
// once, and its stage is one of the active stages (Payment Done, Ready for Renewal, Renewal Done). Same rule as
// the HubSpot view "Finance Collections View-VA".
//
// One owner per field:
//   HubSpot owns: stage (stored as its label), amount_paid, first payment date, deal exists -> new client
//   Derived:      clients.status = Active / Inactive from the stage
//   Shadow owns:  accountant (va_id; HubSpot am_deal_owner only pre-fills a NEW client), bucket, health, tickets
// Nothing here writes the other side's fields, which (with diffing) keeps the sync free of loops.
import type { HubspotDeal } from "./client";

// ------------------------------------------------------------------------------------------- VA rule config

export const DEFAULT_VA_PIPELINE_ID = "1534965463"; // Virtual Accounting
export const DEFAULT_VA_PAID_STAGE_ID = "2462646003"; // Payment Done
/** Payment Done, Ready for Renewal, Renewal Done. */
export const DEFAULT_VA_ACTIVE_STAGE_IDS = [
  "2462646003",
  "3668025064",
  "3102360263",
] as const;

export const STATUS_ACTIVE = "Active";
export const STATUS_INACTIVE = "Inactive";

export type VaConfig = {
  pipelineId: string;
  paidStageId: string;
  activeStageIds: Set<string>;
  /** Deals never treated as clients (test deals). */
  ignoreDealIds: Set<string>;
  /** Stage id -> label for the VA pipeline, from the HubSpot pipelines API. */
  stageLabels: Map<string, string>;
};

/** Comma list of ids; blanks dropped. */
export function parseIdList(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Reads HUBSPOT_VA_PIPELINE_ID, HUBSPOT_VA_PAID_STAGE_ID, HUBSPOT_VA_ACTIVE_STAGE_IDS, HUBSPOT_IGNORE_DEAL_IDS. */
type VaEnv = Record<string, string | undefined>;

/** VA rule from env, with the live portal's ids as defaults. Stage labels are filled in by the caller. */
export function vaConfigFromEnv(
  env: VaEnv,
  stageLabels: Map<string, string> = new Map(),
): VaConfig {
  const active = parseIdList(env.HUBSPOT_VA_ACTIVE_STAGE_IDS);
  return {
    pipelineId: env.HUBSPOT_VA_PIPELINE_ID?.trim() || DEFAULT_VA_PIPELINE_ID,
    paidStageId:
      env.HUBSPOT_VA_PAID_STAGE_ID?.trim() || DEFAULT_VA_PAID_STAGE_ID,
    activeStageIds:
      active.size > 0 ? active : new Set(DEFAULT_VA_ACTIVE_STAGE_IDS),
    ignoreDealIds: parseIdList(env.HUBSPOT_IGNORE_DEAL_IDS),
    stageLabels,
  };
}

/** HubSpot's "Date entered <stage>" property for the paid stage. */
export function paidDateProperty(cfg: Pick<VaConfig, "paidStageId">): string {
  return `hs_v2_date_entered_${cfg.paidStageId}`;
}

/** Deal properties we read when pulling HubSpot-owned fields. */
export function hubspotPullProperties(
  cfg: Pick<VaConfig, "paidStageId">,
): string[] {
  return [
    "dealname",
    "dealstage",
    "pipeline",
    "amount_paid",
    "am_deal_owner",
    "va_1st_payment_date",
    "hs_lastmodifieddate",
    paidDateProperty(cfg),
  ];
}

// -------------------------------------------------------------------------------------------- Shadow -> HubSpot

export const SHADOW_OWNED_PROPERTIES = [
  "va_bucket",
  "va_accountant",
  "va_health_score",
  "va_open_tickets",
  "va_open_escalations",
] as const;
export type ShadowOwnedProperty = (typeof SHADOW_OWNED_PROPERTIES)[number];

export type ShadowDealInput = {
  bucket: string | null;
  vaName: string | null;
  serviceScore: number | null;
  openTickets: number;
  openEscalations: number;
};

/** Values Shadow wants on the deal. va_bucket is left out while bucket storage is not approved. */
export function buildShadowDealProperties(
  input: ShadowDealInput,
  opts: { includeBucket: boolean },
): Partial<Record<ShadowOwnedProperty, string>> {
  const props: Partial<Record<ShadowOwnedProperty, string>> = {
    va_accountant: input.vaName?.trim() ?? "",
    va_health_score:
      input.serviceScore === null ? "" : String(Math.round(input.serviceScore)),
    va_open_tickets: String(input.openTickets),
    va_open_escalations: String(input.openEscalations),
  };
  if (opts.includeBucket) props.va_bucket = input.bucket ?? "";
  return props;
}

function norm(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/** HubSpot returns empty as null and numbers as strings ("72" or "72.0"); treat those as equal. */
export function sameHubspotValue(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x === "" || y === "") return false;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) && nx === ny;
}

/** Only the properties whose desired value differs from what HubSpot already has. */
export function diffDealProperties(
  desired: Record<string, string>,
  current: Record<string, string | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (!sameHubspotValue(value, current[key])) out[key] = value;
  }
  return out;
}

// -------------------------------------------------------------------------------------------- HubSpot -> Shadow

/** Parses a HubSpot number string. Null when blank or not a number. */
export function parseAmount(raw: string | null | undefined): number | null {
  const v = norm(raw).replace(/,/g, "");
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type DealKind = "active" | "inactive" | "ignore";
export type IgnoreReason = "ignore_list" | "other_pipeline" | "never_paid";

/** Active VA client, inactive VA client (churned, parked, ...), or not a VA client at all. */
export function classifyDeal(
  deal: HubspotDeal,
  cfg: VaConfig,
): { kind: DealKind; reason?: IgnoreReason } {
  if (cfg.ignoreDealIds.has(deal.id))
    return { kind: "ignore", reason: "ignore_list" };
  if (norm(deal.properties.pipeline) !== cfg.pipelineId)
    return { kind: "ignore", reason: "other_pipeline" };
  if (norm(deal.properties[paidDateProperty(cfg)]) === "")
    return { kind: "ignore", reason: "never_paid" };
  return {
    kind: cfg.activeStageIds.has(norm(deal.properties.dealstage))
      ? "active"
      : "inactive",
  };
}

/** The stage's label in the VA pipeline; null when unknown (labels not loaded or a stage from another pipeline). */
export function stageLabel(deal: HubspotDeal, cfg: VaConfig): string | null {
  const id = norm(deal.properties.dealstage);
  return id ? (cfg.stageLabels.get(id)?.trim() ?? null) : null;
}

export type ClientDealFields = {
  deal_stage: string | null;
  amount_paid: number | null;
  status: string | null;
};

/**
 * HubSpot-owned client fields that need changing for this deal (empty object when nothing changed or the deal is
 * not a VA client). Never blanks a field: an unknown stage label or empty amount leaves the stored value alone.
 */
export function mapDealToClientPatch(
  deal: HubspotDeal,
  client: ClientDealFields,
  cfg: VaConfig,
): Partial<ClientDealFields> {
  const { kind } = classifyDeal(deal, cfg);
  if (kind === "ignore") return {};
  const patch: Partial<ClientDealFields> = {};
  const label = stageLabel(deal, cfg);
  if (label && label !== (client.deal_stage ?? "")) patch.deal_stage = label;
  const amount = parseAmount(deal.properties.amount_paid);
  if (amount !== null && amount !== client.amount_paid)
    patch.amount_paid = amount;
  const status = kind === "active" ? STATUS_ACTIVE : STATUS_INACTIVE;
  if (status !== client.status) patch.status = status;
  return patch;
}

/** "Ayurpet <> VA" -> "Ayurpet", "RapidFix_VA" -> "RapidFix", "Nyutech[Kiran]_AiA_2026" -> "Nyutech[Kiran]". */
export function cleanDealName(raw: string | null | undefined): string {
  const name = norm(raw);
  const cleaned = name
    .replace(/\s*(<>.*|_\s*(va|aia)(_\d{4})?)\s*$/i, "")
    .trim();
  return cleaned || name;
}

/** Lowercase letters and digits only, for duplicate checks. */
export function nameKey(raw: string | null | undefined): string {
  return norm(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Two client names that probably mean the same client (equal keys, or one contains the other, 4+ chars). */
export function similarNames(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (x.length < 4 || y.length < 4) return x === y && x !== "";
  return x === y || x.includes(y) || y.includes(x);
}

/** YYYY-MM-DD in the given timezone for a HubSpot datetime string; null when blank or invalid. */
export function dateInZone(
  raw: string | null | undefined,
  timezone: string,
): string | null {
  const v = norm(raw);
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(/^\d+$/.test(v) ? Number(v) : v);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export type NewClientFromDeal = {
  client_name: string;
  hubspot_deal_id: string;
  deal_stage: string | null;
  amount_paid: number | null;
  onboarding_date: string | null;
  status: string;
  va_id: string | null;
};

/**
 * New client for an active VA deal. The accountant is pre-filled from HubSpot's AM Deal Owner when that owner's
 * email matches an accountant (vaIdByOwnerId); otherwise it stays empty and shows up in Admin assignment.
 */
export function buildClientFromDeal(
  deal: HubspotDeal,
  cfg: VaConfig,
  o: { vaIdByOwnerId: Map<string, string>; timezone: string },
): NewClientFromDeal {
  const name = cleanDealName(deal.properties.dealname);
  const owner = norm(deal.properties.am_deal_owner);
  return {
    client_name: name || `HubSpot deal ${deal.id}`,
    hubspot_deal_id: deal.id,
    deal_stage: stageLabel(deal, cfg),
    amount_paid: parseAmount(deal.properties.amount_paid),
    onboarding_date:
      dateInZone(deal.properties.va_1st_payment_date, o.timezone) ??
      dateInZone(deal.properties[paidDateProperty(cfg)], o.timezone),
    status: STATUS_ACTIVE,
    va_id: owner ? (o.vaIdByOwnerId.get(owner) ?? null) : null,
  };
}

export type LinkedClient = ClientDealFields & { client_id: string };
/** Any existing client (linked to a deal or not), for the duplicate-name check. */
export type KnownClient = { client_id: string; client_name: string };

export type PullPlan = {
  updates: {
    clientId: string;
    dealId: string;
    patch: Partial<ClientDealFields>;
  }[];
  creates: NewClientFromDeal[];
  /**
   * Active deals with no linked client but a similar name already in Shadow (an existing client, or another deal
   * in this run): a person links or creates them by hand, nothing is created. clientId is null for a same-run match.
   */
  needsReview: {
    dealId: string;
    dealName: string;
    clientId: string | null;
    clientName: string;
  }[];
  unchanged: number;
  counts: {
    active: number;
    inactive: number;
    ignored: Record<IgnoreReason, number>;
  };
};

/**
 * Decide what a batch of pulled deals does to clients.
 * clientsByDealId: hubspot_deal_id -> client. known: every existing client (for the duplicate-name check, so a
 * second deal for a client that is already linked to an older deal is not created again).
 */
export function planDealPull(
  deals: HubspotDeal[],
  clientsByDealId: Map<string, LinkedClient>,
  known: KnownClient[],
  cfg: VaConfig,
  o: { vaIdByOwnerId: Map<string, string>; timezone: string },
): PullPlan {
  const plan: PullPlan = {
    updates: [],
    creates: [],
    needsReview: [],
    unchanged: 0,
    counts: {
      active: 0,
      inactive: 0,
      ignored: { ignore_list: 0, other_pipeline: 0, never_paid: 0 },
    },
  };
  const seen = new Set<string>();
  for (const deal of deals) {
    if (seen.has(deal.id)) continue;
    seen.add(deal.id);
    const { kind, reason } = classifyDeal(deal, cfg);
    if (kind === "ignore") {
      plan.counts.ignored[reason as IgnoreReason]++;
      continue;
    }
    plan.counts[kind]++;
    const client = clientsByDealId.get(deal.id);
    if (client) {
      const patch = mapDealToClientPatch(deal, client, cfg);
      if (Object.keys(patch).length > 0)
        plan.updates.push({
          clientId: client.client_id,
          dealId: deal.id,
          patch,
        });
      else plan.unchanged++;
      continue;
    }
    if (kind !== "active") continue; // never create a client for a churned or parked deal
    const row = buildClientFromDeal(deal, cfg, o);
    const dealName = norm(deal.properties.dealname);
    const existing = known.find((c) =>
      similarNames(c.client_name, row.client_name),
    );
    const sameRun = plan.creates.find((c) =>
      similarNames(c.client_name, row.client_name),
    );
    if (existing) {
      plan.needsReview.push({
        dealId: deal.id,
        dealName,
        clientId: existing.client_id,
        clientName: existing.client_name,
      });
    } else if (sameRun) {
      plan.needsReview.push({
        dealId: deal.id,
        dealName,
        clientId: null,
        clientName: sameRun.client_name,
      });
    } else {
      plan.creates.push(row);
    }
  }
  return plan;
}

/** At most this many clients are created in one run. More means the VA rule or its config is wrong. */
export const MAX_CREATES_PER_RUN = 10;

/** Fails closed: more than `cap` creates means none run, and the caller reports an error. */
export function gateClientCreates<T>(
  creates: T[],
  cap = MAX_CREATES_PER_RUN,
): { allowed: T[]; held: number } {
  if (creates.length > cap) return { allowed: [], held: creates.length };
  return { allowed: creates, held: 0 };
}
