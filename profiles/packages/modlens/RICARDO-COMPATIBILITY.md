# Ricardo DSH compatibility fork

- Upstream package: `@liustack/modlens@3.18.1`
- Imported client SHA-256: `585d992eecffcfc3a9f5b611898f8385f34a9be584fdb8b2f35010b186ae9fb7`
- Local version: `3.18.1-ricardo.1`
- Compatibility change: add the required stable `key: 'modlens'` to the keyed `settings.plugin.item` slot registration.

All other published upstream files are preserved byte-for-byte. Packaging scripts and development-only dependencies were removed because this directory contains the already-built published artifact and must pack without rebuilding from absent source files.
