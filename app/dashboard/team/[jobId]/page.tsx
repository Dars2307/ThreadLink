import { notFound, redirect } from "next/navigation";

import { loadJob } from "@/lib/dashboard/data";
import { parseJobParam, projectHref } from "@/lib/dashboard/project";

/**
 * Old address of the full team log. A job now lives on its project's page
 * (Progress tab); keep old links working by sending them there. A job that is
 * not yours reads exactly like one that does not exist.
 */
export default async function TeamLogRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { jobId } = await params;
  const search = await searchParams;
  const id = parseJobParam(jobId);
  const job = id ? await loadJob(id) : null;
  if (!job || !job.roomId) notFound();
  const keep: Record<string, string> = {};
  for (const k of ["f", "d", "m"]) {
    const v = search[k];
    if (typeof v === "string" && /^\d{1,4}$/.test(v)) keep[k] = v;
  }
  redirect(projectHref(job.roomId, { tab: "progress", job: job.detail.jobId, extra: keep }));
}
