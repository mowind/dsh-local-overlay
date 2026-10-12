/**
 * Host half of the probe bundle: a third-party plugin that declares nothing but
 * a configuration schema.
 *
 * The declaration below is the whole contract the settings service needs. The
 * profile entry id this row is inserted under becomes the settings namespace,
 * and every field carrying `.volatile()` becomes an editable form field, so a
 * plugin that ships no client half of its own is configurable through the
 * ordinary page without any list of known plugins.
 */
import z from "@deepseek-ai/schemastery";

/** Profile entry id of this bundle's row, which is also the settings namespace the Host serves. */
const name = "e2e-config-probe";

/** The probe needs no services; an empty apply keeps its row active and nothing else. */
const inject = [];

/**
 * The fields the probe publishes.
 *
 * `attempts` is bounded on purpose. The Host resolves a written configuration
 * against this schema before it lands, so the suite can drive a value the page
 * itself accepts and watch the deployment refuse it.
 */
const Config = z.object({
  label: z.string().default("probe-default").volatile(),
  attempts: z.number().step(1).min(1).max(9).default(3).volatile(),
});

/** Keep the row active. */
function apply() {}

export { Config, apply, inject, name };
