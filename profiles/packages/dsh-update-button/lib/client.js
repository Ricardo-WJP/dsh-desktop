window.__ModuleLoader__.load({
	id: "dsh-update-button",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const ACTION_NAME = "sidebar.footer.action";
		const ACTION_ID = "dsh-update-button";
		const inject = ["slots"];

		/**
		 * The only accepted click path is the trusted Desktop workspace bridge.
		 * Missing or differently-shaped bridges are intentionally inert.
		 */
		function updateNavigator(root = globalThis) {
			const openUpdate = root?.dshDesktop?.openUpdate;
			return typeof openUpdate === "function" ? openUpdate : undefined;
		}

		function openUpdateRoute() {
			const navigate = updateNavigator();
			if (navigate === undefined) return false;
			try {
				const result = navigate();
				if (result !== null && result !== undefined && typeof result.catch === "function") {
					result.catch(() => {});
				}
				return true;
			} catch {
				return false;
			}
		}

		function UpdateButton({ wide }) {
			if (updateNavigator() === undefined) return null;
			return react.createElement(
				"button",
				{
					type: "button",
					title: "更新 DSH / Update DSH",
					"aria-label": "更新 DSH",
					className: "dsh-update-button",
					"data-sidebar-wide": wide === true ? "true" : "false",
					onClick: openUpdateRoute,
				},
				wide === true ? "更新" : "↻",
			);
		}

		function apply(ctx) {
			const slots = ctx?.slots;
			if (slots === null
				|| slots === undefined
				|| typeof slots.inject !== "function"
				|| typeof slots.register !== "function") return;

			try {
				return slots.inject(ACTION_NAME, () => slots.register({
					name: ACTION_NAME,
					id: ACTION_ID,
					order: 100,
					label: "更新 DSH",
				}, UpdateButton));
			} catch {
				return undefined;
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
