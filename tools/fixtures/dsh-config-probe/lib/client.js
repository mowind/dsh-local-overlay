/**
 * Browser half of the probe bundle: the configuration page of a third-party
 * plugin, registered into the Plugins page's standard slots.
 *
 * The page is keyed by this package's name and mounted only while the Host
 * serves the plugin's settings namespace, exactly like the shipped
 * `ui-settings-web-search` page. It requires nothing but the platform baseline
 * (React and the shared UI primitives), so the same bundle loads under the
 * original composition and under the replacement.
 *
 * Hand-written rather than compiled: this fixture is a build artifact of the
 * end-to-end suite, not of any package pipeline, so it is kept readable.
 */
window.__ModuleLoader__.load({
  id: "@dsh-local-overlay/e2e-config-probe",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = react.createElement;
    /** Profile entry id of the probe row, which is also the settings namespace the Host serves. Spelled here rather than imported: a client package must not depend on a Host package. */
    const NS = "e2e-config-probe";
    /** Bundle name this page is keyed by on the Plugins page. */
    const PKG = "@dsh-local-overlay/e2e-config-probe";
    /** Copy of the page. Fixed English: a probe has no locale bundle to register. */
    const labels = {
      title: "Probe configuration",
      description: "Fields declared by the probe bundle.",
      label: "Probe label",
      labelHint: "Staged until you save; the instance keeps its own value until then.",
      attempts: "Probe attempts",
      attemptsHint: "A whole number between 1 and 9.",
      overridden: "Override",
      reset: "Reset",
      invalidNumber: "Enter a whole number, or leave the field empty.",
      save: "Save probe",
      saving: "Saving probe",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      readOnly: "This page can read the probe configuration but not change it.",
      unavailable: "This page cannot reach the probe configuration.",
    };
    /** Bridges the probe's settings scope onto the page's form. */
    class ProbeController {
      constructor(scope) {
        this.scope = scope;
        this.form = new primitives.SettingsFormModel(scope, [
          primitives.settingsTextField("label"),
          primitives.settingsNumberField("attempts"),
        ]);
        this.store = this.form.bind(() => this.projection());
      }
      projection() {
        return {
          ...this.form.shell(),
          label: this.form.field("label"),
          attempts: this.form.field("attempts"),
        };
      }
      /** The face the slot registration injects: the form snapshot and its staged actions. */
      inject() {
        return { hooks: { probeForm: this.store }, ...this.form.actions() };
      }
      dispose() {
        this.form.dispose();
      }
    }
    /** One field, staged and reset through the actions the form model handed the page. */
    const probeField = (props, state, disabled, spec) => h(primitives.SettingsValueField, {
      id: spec.id,
      label: spec.label,
      hint: spec.hint,
      overriddenLabel: labels.overridden,
      resetLabel: labels.reset,
      invalidLabel: labels.invalidNumber,
      numeric: spec.numeric === true,
      disabled,
      ...state[spec.name],
      onEdit: (text) => props.edit(spec.name, text),
      onReset: () => props.resetField(spec.name),
    });
    /** The page the Plugins page renders in its own container. */
    function ProbeForm(props) {
      const state = props.useProbeForm((snapshot) => snapshot);
      if (props.view === "summary") return labels.description;
      const disabled = !state.writable;
      return h(
        primitives.SettingsForm,
        { labels, state, onSave: props.save, onDiscard: props.discard },
        probeField(props, state, disabled, { name: "label", id: "plugin-config-probe-label", label: labels.label, hint: labels.labelHint }),
        probeField(props, state, disabled, { name: "attempts", id: "plugin-config-probe-attempts", label: labels.attempts, hint: labels.attemptsHint, numeric: true }),
      );
    }
    /** Required services: the slot registry and the settings forms the Host serves. */
    const inject = ["slots", "configForms"];
    function apply(ctx) {
      const controller = new ProbeController(ctx.configForms.get(NS));
      ctx.effect(() => () => controller.dispose(), "e2e-config-probe: form subscription");
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config",
        key: PKG,
        order: 90,
        label: () => labels.title,
        inject: () => controller.inject(),
      }, ProbeForm))), "e2e-config-probe: page");
    }
    exports.NS = NS;
    exports.PKG = PKG;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
