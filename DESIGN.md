# Desktop control center

## Approved direction

The user subsequently delegated selection under **DSH native design rules** on 2026-09-06. Current selection: **A: 侧栏总览**, `.impeccable/mocks/dsh-native-control-a.png`, approval recorded in its JSON sidecar, concept key `cbf0029e`. This supersedes the earlier B workbench (`c1467f2d`); its references remain for history.

Use a 210px native sidebar and a flat operation-first overview. Opening the workspace is the primary action; a compact status strip precedes update and recovery rows. Recent activity must come from actual bounded logs, otherwise show an honest empty state. Runtime metadata and program rollback stay in a collapsed disclosure. On narrow windows navigation moves above the content without horizontal overflow.

## Visual system

- Native, restrained desktop utility; not a marketing dashboard.
- Neutral charcoal backgrounds, quiet dividers, strong readable Chinese system typography, restrained periwinkle-blue action emphasis.
- Follow system light/dark preference. Keep text and disabled states readable in both themes.
- Consistent outline icons and control heights. Buttons with text retain readable padding; avoid decorative badges or repeated icons.
- Text controls use capsule corners; icon-only controls must be circular. The generated comp's rectangular buttons are intentionally adapted to the user's explicit DSH requirement. Use neutral white/light-gray surfaces in light mode and native charcoal in dark mode, not Google's palette.
- Plugin recommendation page is not redesigned. Its optional shortlist is market, sidebar and notification; the explicit full-suite inventory and installed plugins remain intact.
- Comfortable spacing at desktop size. Stack the information column on narrow windows; never shrink text until controls overlap.
- Visible keyboard focus and meaningful accessible names. Pending actions cannot be double-submitted; errors stay visible with a clear next step.

## Content and interaction contract

- All state is derived from the desktop host. Never convert missing or never-checked data into 'healthy', 'latest', or a fabricated event.
- Program rollback changes the DSH candidate while retaining current user data. Historical data restoration is a distinct action, confirms replacement of later changes and creates a rescue backup first.
- A generated comp is not evidence of live versions, activity or readiness. Do not copy its illustrative numbers or 'irreversible' wording.
- Keep existing route callbacks and safety restrictions. Unsupported actions explain why they are unavailable.
- Scope is the control center only: do not change the native DSH workspace, plugin animations, model credentials or account routing.

## Verification

Before delivery, render the implemented React interface at wide and narrow sizes, in dark and light mode. Check navigation, action feedback, error/empty states and overflow. Unit tests and mock host fixtures supplement, but do not replace, actual installed-app verification.
