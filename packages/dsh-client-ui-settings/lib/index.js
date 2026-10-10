import z from "@deepseek-ai/schemastery";
import { assertBaselineIdentity } from "./baseline-identity.js";
//#region lib/types/developer-tools-settings.js
/** Shared Web and desktop developer-tool preference stored by the Host. */
/** New installations and missing values enable the full interface. */
const DeveloperToolsSettingsFields = { enabled: z.boolean().default(true) };
z.object(DeveloperToolsSettingsFields);
//#endregion
//#region lib/types/index.js
/** Live preferences projected to the browser. */
const Config = z.object({ enabled: DeveloperToolsSettingsFields["enabled"].volatile() });
/** Host preferences are consumed through the configuration form projection.
* @param ctx Plugin context used for optional settings presentation.
*/
function apply(ctx) {
	/* Refuse to serve on an installation this copy was not verified against: a version
	string alone cannot tell whether the build underneath still accepts this replacement. */
	assertBaselineIdentity();
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
}
//#endregion
export { Config, apply };
