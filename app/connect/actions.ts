"use server";

import { redirect } from "next/navigation";

import { decideDevice } from "@/lib/device/approve";

export async function approveDeviceAction(formData: FormData): Promise<void> {
  const ok = await decideDevice(formData.get("code"), true);
  redirect(ok ? "/connect?result=approved" : "/connect?result=invalid");
}

export async function denyDeviceAction(formData: FormData): Promise<void> {
  const ok = await decideDevice(formData.get("code"), false);
  redirect(ok ? "/connect?result=denied" : "/connect?result=invalid");
}
