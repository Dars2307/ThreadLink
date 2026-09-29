import type { Metadata } from "next";

import {
  setPaidUsageAction,
  setProviderPlanAction,
  setUsagePolicyAction,
} from "@/app/dashboard/team-actions";
import { ActionForm, SubmitButton } from "@/components/dashboard/action-form";
import { ConfirmAction } from "@/components/dashboard/confirm-action";
import { FailoverSetting } from "@/components/dashboard/failover-setting";
import { SettingsNav } from "@/components/dashboard/settings-nav";
import { LoadError, PageHeader, Shell } from "@/components/dashboard/shell";
import { Badge, buttonStyles, Card } from "@/components/ui";
import { loadProviders } from "@/lib/dashboard/data";
import { deriveProviders, providerVendor } from "@/lib/dashboard/pages";

export const metadata: Metadata = { title: "Providers & plans · ThreadLink" };

export default async function ProvidersPage() {
  const data = await loadProviders();
  if (!data) return <LoadError what="your provider settings" />;
  const { view } = deriveProviders(data.profiles, data.now);

  return (
    <Shell>
      <PageHeader title="Settings" />
      <SettingsNav current="/dashboard/settings/providers" />

      <Card>
        <FailoverSetting />
      </Card>

      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Providers &amp; plans</h2>
        <p className="text-muted max-w-2xl text-sm">{view.teamModeNote}</p>
      </div>

      {view.providers.map((p) => (
        <Card key={p.provider} as="article" labelledBy={`${p.provider}-title`}>
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${p.provider}-title`} className="text-base font-semibold tracking-tight">
                {p.title}
              </h3>
              <Badge tone={p.detected.seen ? "success" : "neutral"}>
                {p.detected.seen ? "Detected" : "Not detected yet"}
              </Badge>
            </div>

            {p.planWarning ? (
              <p
                role="status"
                className="border-warning/40 bg-warning-soft text-warning rounded-xl border px-4 py-3 text-sm"
              >
                {p.planWarning}
              </p>
            ) : null}

            <div className="grid gap-6 md:grid-cols-2">
              <section
                className="flex flex-col gap-3"
                aria-labelledby={`${p.provider}-plan-heading`}
              >
                <h4 id={`${p.provider}-plan-heading`} className="text-subtle text-xs font-medium">
                  Your plan
                </h4>
                <p className="text-sm">
                  <span className={p.declared.isSet ? "font-medium" : "text-warning font-medium"}>
                    {p.declared.label}
                  </span>
                </p>
                <ActionForm action={setProviderPlanAction} className="flex flex-col gap-2">
                  <input type="hidden" name="provider" value={p.provider} />
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="sr-only">Plan for {p.title}</span>
                      {/* Keyed on the saved value: after saving, React resets the form and
                          an unkeyed select would snap back to the value it first mounted with. */}
                      <select
                        key={p.declared.value}
                        name="declaredPlan"
                        defaultValue={p.declared.value}
                        className="border-border-strong bg-surface rounded-lg border px-3 py-2"
                      >
                        {p.declared.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <SubmitButton>Save plan</SubmitButton>
                  </div>
                </ActionForm>
                <p className="text-subtle text-xs">{p.note}</p>
              </section>

              <section
                className="flex flex-col gap-3"
                aria-labelledby={`${p.provider}-detected-heading`}
              >
                <h4
                  id={`${p.provider}-detected-heading`}
                  className="text-subtle text-xs font-medium"
                >
                  Provider reported
                </h4>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  {p.detected.rows.map((r) => (
                    <div key={r.label} className="contents">
                      <dt className="text-muted">{r.label}</dt>
                      <dd className="text-right font-medium sm:text-left">{r.value}</dd>
                    </div>
                  ))}
                  <dt className="text-muted">Remaining usage</dt>
                  <dd className="text-right font-medium sm:text-left">{p.remaining}</dd>
                </dl>
                {p.detected.planNote ? (
                  <p className="text-muted text-xs">{p.detected.planNote}</p>
                ) : null}
                {p.detected.planDiffers ? (
                  <p className="text-warning text-xs">{p.detected.planDiffers}</p>
                ) : null}
                <p className="text-subtle text-xs">{p.detected.when}</p>
              </section>
            </div>

            <section className="border-border flex flex-col gap-3 border-t pt-5">
              <h4 className="text-subtle text-xs font-medium">Usage policy</h4>
              <ActionForm action={setUsagePolicyAction} className="flex flex-col gap-2">
                <input type="hidden" name="provider" value={p.provider} />
                {/* Keyed on the saved policy so the checked radio always matches it. */}
                <fieldset key={p.usagePolicy.value} className="grid gap-2 sm:grid-cols-2">
                  <legend className="sr-only">Usage policy for {p.title}</legend>
                  {p.usagePolicy.options.map((o) => (
                    <label
                      key={o.value}
                      className="border-border has-[:checked]:border-accent has-[:checked]:bg-accent-soft flex cursor-pointer gap-3 rounded-xl border p-3 text-sm"
                    >
                      <input
                        type="radio"
                        name="usagePolicy"
                        value={o.value}
                        defaultChecked={p.usagePolicy.value === o.value}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block font-medium">{o.label}</span>
                        <span className="text-muted block text-xs">{o.description}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <SubmitButton className={`${buttonStyles.secondary} w-fit`}>
                  Save policy
                </SubmitButton>
              </ActionForm>
            </section>

            <section className="border-border flex flex-col gap-3 border-t pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-subtle text-xs font-medium">Paid usage</h4>
                <Badge tone={p.paidUsage.enabled ? "warning" : "neutral"}>
                  {p.paidUsage.label}
                </Badge>
              </div>
              <p className="text-muted text-sm">
                {p.paidUsage.enabled
                  ? `You allowed extra paid usage for ${providerVendor(p.provider)} if your plan offers it.`
                  : "Off. ThreadLink only uses what your plan already includes."}
              </p>
              {p.paidUsage.enabled ? (
                <ActionForm action={setPaidUsageAction} className="flex flex-col gap-1">
                  <input type="hidden" name="provider" value={p.provider} />
                  <input type="hidden" name="paidUsage" value="off" />
                  <SubmitButton className={`${buttonStyles.secondary} w-fit`}>
                    Turn off paid usage
                  </SubmitButton>
                </ActionForm>
              ) : (
                <div>
                  <ConfirmAction
                    action={setPaidUsageAction}
                    fields={{ provider: p.provider, paidUsage: "on", confirmed: "I understand" }}
                    label="Allow paid usage…"
                    title={`Allow paid usage for ${providerVendor(p.provider)}?`}
                    confirmLabel="Allow paid usage"
                    tone="primary"
                  >
                    <p>
                      This only records that you allow paid usage your {providerVendor(p.provider)}{" "}
                      plan already offers.
                    </p>
                    <p className="text-foreground font-medium">
                      ThreadLink will never buy credits, switch to API keys or turn on auto-reload
                      by itself.
                    </p>
                    <p>Team Mode itself still runs only on the usage your subscription includes.</p>
                  </ConfirmAction>
                </div>
              )}
            </section>
          </div>
        </Card>
      ))}
    </Shell>
  );
}
