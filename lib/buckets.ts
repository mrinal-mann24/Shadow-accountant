// Ops buckets (owned by Shadow Accountant, pushed to HubSpot as va_bucket).
// Placeholder list until leadership confirms the full set and meanings. Storage is not approved yet:
// see supabase/proposals/client-bucket.sql. No server-only import so UI can use BUCKETS.
import type { AppUser } from "@/lib/auth/types";

export const BUCKETS: { key: string; label: string; description: string }[] = [
  {
    key: "YTRO",
    label: "YTRO",
    description: "Meaning to be confirmed with leadership",
  },
  {
    key: "DC",
    label: "DC",
    description: "Meaning to be confirmed with leadership",
  },
  {
    key: "DS",
    label: "DS",
    description: "Meaning to be confirmed with leadership",
  },
];

/** False until a clients.bucket column is approved and added. The HubSpot sync skips va_bucket while false. */
export const BUCKET_STORAGE_APPROVED = false;

export class BucketStorageNotApprovedError extends Error {
  constructor() {
    super(
      "Bucket storage is not approved yet. See supabase/proposals/client-bucket.sql.",
    );
    this.name = "BucketStorageNotApprovedError";
  }
}

export function isBucketKey(value: string): boolean {
  return BUCKETS.some((b) => b.key === value);
}

/** Always null until bucket storage is approved. */
export async function getClientBucket(
  clientId: string,
): Promise<string | null> {
  void clientId;
  return null;
}

/** Throws BucketStorageNotApprovedError until a column is approved. Once approved: scope by user, refuse view-as. */
export async function setClientBucket(
  user: AppUser,
  clientId: string,
  bucket: string,
): Promise<void> {
  void user;
  void clientId;
  void bucket;
  throw new BucketStorageNotApprovedError();
}
