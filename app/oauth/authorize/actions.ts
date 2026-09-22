"use server";

import { redirect } from "next/navigation";

import { approve, denyUrl, validateAuthorization } from "@/lib/oauth/authorize";

const FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
  "scope",
] as const;

function readFields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = formData.get(field);
    if (typeof value === "string" && value !== "") out[field] = value;
  }
  return out;
}

/** Re-validates everything server-side (hidden fields are untrusted). */
export async function approveAuthorization(formData: FormData): Promise<void> {
  const validated = await validateAuthorization(readFields(formData));
  if ("error" in validated) redirect("/oauth/authorize?error=invalid_request");
  redirect(await approve(validated));
}

export async function denyAuthorization(formData: FormData): Promise<void> {
  const validated = await validateAuthorization(readFields(formData));
  if ("error" in validated) redirect("/dashboard");
  redirect(denyUrl(validated));
}
