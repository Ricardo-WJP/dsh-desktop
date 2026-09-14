const block = (...lines) => lines.join("\n");
const operation = (id, find, replace) => Object.freeze({ id, find, replace });
const assertion = (id, anchor, count = 1) => Object.freeze({ id, anchor, count });

const routePolicy = Object.freeze({
  main: Object.freeze({
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh"
  }),
  subagent: Object.freeze({
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "max"
  }),
  inheritance: Object.freeze({
    authority: "parent.session.requestHeader().config",
    adapterDefaultsAreAbsent: true,
    sameProviderAndModelInheritsReasoningEffort: true,
    routeChangeWithoutExplicitReasoningEffortClearsIt: true,
    explicitChildReasoningEffortWins: true,
    coldResumeReadsPersistedDescriptor: true
  })
});

const restartGoalTicket = Object.freeze({
  api: Object.freeze({
    get: "goals.get(agent)",
    disarm: "goals.disarm(agent)",
    resume: "goals.resume(agent, ref)",
    sessionStart: "agent/session-start"
  }),
  identity: Object.freeze(["sessionId", "goalId", "revision"]),
  activeState: Object.freeze(["phase=active", "activation=armed"]),
  roundGuard: "roundsStarted < maxGoalRounds",
  target: Object.freeze({
    package: "dsh-restart-tool",
    path: "profiles/packages/dsh-restart-tool/lib/index.js",
    sourceSha256: "8a1db25fc4f9558e91be16520f2e66bdaf6f8eca25d29c7ca35c636679546d61",
    appliedSha256: "8a1db25fc4f9558e91be16520f2e66bdaf6f8eca25d29c7ca35c636679546d61",
    assertions: Object.freeze([
      assertion("session-start-hook", "ctx.on('agent/session-start'"),
      assertion("goal-ticket-read", "goal = ctx.goals.get(agent)", 2),
      assertion("goal-ticket-resume", "ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })"),
      assertion("goal-ticket-disarm", "ctx.goals.disarm(agent)"),
      assertion("goal-round-guard", "goal.roundsStarted < goal.maxGoalRounds", 2)
    ])
  })
});

const targets = [
  {
    id: "agent-default-model",
    package: "@deepseek-ai/dsh-agent-default-model",
    path: "node_modules/@deepseek-ai/dsh-agent-default-model/lib/index.js",
    sourceSha256: "3f9ec5b953658fa1d0b3684b404a8da62ed61b5770ca8dd6b72ce937bae21ecf",
    appliedSha256: "3f9ec5b953658fa1d0b3684b404a8da62ed61b5770ca8dd6b72ce937bae21ecf",
    operations: [],
    assertions: [
      assertion("generic-default-model-schema", block(
        "const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA = z.object({",
        "\tprovider: z.string().required(),",
        "\tmodel: z.string().required(),",
        "\treasoningEffort: z.string()",
        "});"
      )),
      assertion("reasoning-effort-id", "ReasoningEffortId(settings.reasoningEffort)")
    ]
  },
  {
    id: "windows-directory-picker-host",
    package: "@deepseek-ai/dsh-host-directory-picker-native",
    path: "node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/index.js",
    sourceSha256: "716633a2e4fbf240b618a844476319cd76d940c33f29f940905a5216889d1bd5",
    appliedSha256: "af572c51ab08bef01156d5ae7bf8c6f95b1ce5a5083de997db4fcd356f47308b",
    operations: [
      operation("electron-worker-node-mode", block(
        "\tconst env = {",
        "\t\t...process.env,",
        "\t\tDSH_DIALOG_TITLE: data.title",
        "\t};"
      ), block(
        "\tconst env = {",
        "\t\t...process.env,",
        "\t\tELECTRON_RUN_AS_NODE: \"1\",",
        "\t\tDSH_DIALOG_TITLE: data.title",
        "\t};"
      ))
    ],
    assertions: [
      assertion("electron-run-as-node", "ELECTRON_RUN_AS_NODE: \"1\"")
    ]
  },
  {
    id: "windows-directory-picker-worker",
    package: "@deepseek-ai/dsh-host-directory-picker-native",
    path: "node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs",
    sourceSha256: "8ff0995ab762380fddeddd3bb92079f60b10031c944f87a0ff58396ed2f85852",
    appliedSha256: "4219c37bb440b8a3f62a4bc3e376670da47c071682bed6ae7fe9e071242da2f2",
    operations: [
      operation("electron-safe-utf16-decoder", block(
        "* `_Out_ void **` out-params surface a raw address, and",
        "* `koffi.decode(addr, 'str16')` would dereference it as a pointer — crash",
        "* on real Windows — so view the memory directly instead.",
        "*/",
        "function readUtf16(koffi, address) {",
        "\tconst bytes = Buffer.from(koffi.view(address, 32768));",
        "\tlet end = 0;",
        "\twhile (end + 1 < bytes.length && bytes[end] !== 0) end += 2;",
        "\treturn bytes.toString(\"utf16le\", 0, end);",
        "}"
      ), block(
        "* `_Out_ void **` out-params surface a raw address. Use the direct string",
        "* decoder because `koffi.view()` relies on external buffers, which Electron",
        "* runtimes do not support.",
        "*/",
        "function readUtf16(koffi, address) {",
        "\treturn koffi.decode.string16(address);",
        "}"
      ))
    ],
    assertions: [
      assertion("electron-safe-string16", "return koffi.decode.string16(address);")
    ]
  },
  {
    id: "minimal-windows-workspace-shell",
    package: "@deepseek-ai/dsh",
    path: "node_modules/@deepseek-ai/dsh/config/agent-presets/minimal/agent.cordis.yml",
    sourceSha256: [
      "c952e72ff87cb09e6d2700dcf806c6584a67cf867adcd103ec822a6c538d4f87",
      "fc9f4b4d51b4df24829a584f268a3db0b3fad3741439d65f2c02a21c21867160"
    ],
    appliedSha256: "d1dcaf181bec0a37fc0fa9c9815835e152c5d3027bbaadcb6aa36a3302e86606",
    operations: [
      operation(
        "ground-minimal-agent-in-workspace",
        [
          "    text: You are a helpful software engineer assistant.",
          "    text: You are a helpful software engineer assistant. Your working directory is {{cwd}}. Use this exact absolute path for workspace operations and inspect it before trying other locations."
        ],
        "    text: You are a helpful software engineer assistant. Your working directory is {{cwd}}. Use this exact absolute path for workspace operations and inspect it before trying other locations."
      ),
      operation(
        "disable-windows-pty-backend",
        [
          block(
            "    - id: terminal-pwsh",
            "      name: '@deepseek-ai/dsh-terminal-bash'",
            "      disabled: !!js process.platform !== 'win32'",
            "      config:",
            "        shellDialect: pwsh",
            "        timeoutMs: 300000"
          ),
          block(
            "    - id: terminal-pwsh",
            "      name: '@deepseek-ai/dsh-terminal-bash'",
            "      disabled: !!js process.platform !== 'win32'",
            "      config:",
            "        shellDialect: pwsh",
            "        shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
            "        timeoutMs: 300000"
          )
        ],
        block(
          "    - id: terminal-pwsh",
          "      name: '@deepseek-ai/dsh-terminal-bash'",
          "      disabled: true",
          "      config:",
          "        shellDialect: pwsh",
          "        timeoutMs: 300000"
        )
      ),
      operation(
        "disable-windows-persistent-pwsh-tool",
        block(
          "    - id: persistent-pwsh",
          "      name: '@deepseek-ai/dsh-tool-pwsh-persistent'",
          "      disabled: !!js process.platform !== 'win32'"
        ),
        block(
          "    - id: persistent-pwsh",
          "      name: '@deepseek-ai/dsh-tool-pwsh-persistent'",
          "      disabled: true"
        )
      ),
      operation(
        "mount-stable-windows-pwsh-tool",
        block(
          "# The bare local filesystem shadows the host's sandboxed provider only for this",
          "# preset. The editor shares that realm and requires absolute paths."
        ),
        block(
          "# Windows ConPTY exits during startup under the workspace sandbox. Keep the",
          "# minimal two-tool contract while using the stable one-shot PowerShell tool.",
          "- id: tool-pwsh",
          "  name: '@deepseek-ai/dsh-tool-pwsh'",
          "  disabled: !!js process.platform !== 'win32'",
          "",
          "# The bare local filesystem shadows the host's sandboxed provider only for this",
          "# preset. The editor shares that realm and requires absolute paths."
        )
      )
    ],
    assertions: [
      assertion("minimal-workspace-context", "Your working directory is {{cwd}}."),
      assertion("windows-pty-disabled", "    - id: terminal-pwsh\n      name: '@deepseek-ai/dsh-terminal-bash'\n      disabled: true"),
      assertion("windows-persistent-tool-disabled", "    - id: persistent-pwsh\n      name: '@deepseek-ai/dsh-tool-pwsh-persistent'\n      disabled: true"),
      assertion("stable-windows-pwsh-tool", "- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'")
    ]
  },
  {
    id: "agent-loop",
    package: "@deepseek-ai/dsh-agent-loop",
    path: "node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js",
    sourceSha256: "1ca83637892559e88c43b815e8d5d7b065951751e73eee7a7bef99d65a71ad6c",
    appliedSha256: "fa3bad6274d9094519ed40ecd0822e5da0311a86f0a97ea94b979fdde7c9e465",
    operations: [
      operation("persisted-effort-override", block(
        "\t\t\tprovider: this.options.provider ?? \"\",",
        "\t\t\tmodel: this.options.model ?? \"\"",
        "\t\t};",
        "\t\tconst reasoningEffort = persistedConfig?.provider === route.provider && persistedConfig.model === route.model && persistedHeader?.adapterDefaults?.reasoningEffort !== true ? persistedConfig.reasoningEffort : void 0;",
        "\t\tconst maxTokens = this.options.maxTokens;",
        "\t\tconst seedConfig = deepFreeze(structuredClone(this.requestHeaderLogged ? requestProposal(persistedHeader) : {",
        "\t\t\t...route,"
      ), block(
        "\t\t\tprovider: this.options.provider ?? \"\",",
        "\t\t\tmodel: this.options.model ?? \"\"",
        "\t\t};",
        "\t\tconst persistedReasoningEffort = persistedConfig?.provider === route.provider && persistedConfig.model === route.model && persistedHeader?.adapterDefaults?.reasoningEffort !== true ? persistedConfig.reasoningEffort : void 0;",
        "\t\tconst reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort;",
        "\t\tconst maxTokens = this.options.maxTokens;",
        "\t\tconst seedConfig = deepFreeze(structuredClone(this.requestHeaderLogged ? requestProposal(persistedHeader) : {",
        "\t\t\t...route,"
      )),
      operation("validate-reasoning-effort", block(
        "}",
        "/** Reject an output-token cap that cannot be represented exactly on the request wire. */",
        "function assertAgentOptions(options) {",
        "\tif (options.maxTokens !== void 0 && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) throw new TypeError(\"agent maxTokens must be a positive safe integer\");",
        "}",
        "/**"
      ), block(
        "}",
        "/** Reject an output-token cap that cannot be represented exactly on the request wire. */",
        "function assertAgentOptions(options) {",
        "\tif (options.reasoningEffort !== void 0 && (typeof options.reasoningEffort !== \"string\" || options.reasoningEffort.length === 0)) throw new TypeError(\"agent reasoningEffort must be a non-empty string\");",
        "\tif (options.maxTokens !== void 0 && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) throw new TypeError(\"agent maxTokens must be a positive safe integer\");",
        "}",
        "/**"
      ))
    ],
    assertions: [
      assertion("reasoning-override", "const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort;"),
      assertion("effort-validation", "agent reasoningEffort must be a non-empty string")
    ]
  },
  {
    id: "tool-subagent",
    package: "@deepseek-ai/dsh-tool-subagent",
    path: "node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js",
    sourceSha256: "926c0656efa687d22a8651fdd67c20a11b721f94826f2f2d02e03a07cce1b697",
    appliedSha256: "409e68a078ce38fa59e081d2fd4b6899b33ba8fd1ca85ba1f72f52bd58af791e",
    operations: [
      operation("configured-reasoning-effort", block(
        "\tagentOptions: z.object({",
        "\t\tprovider: z.string(),",
        "\t\tmodel: z.string(),",
        "\t\tmaxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)",
        "\t}).default(void 0),",
        "\tpersona: z.string(),"
      ), block(
        "\tagentOptions: z.object({",
        "\t\tprovider: z.string(),",
        "\t\tmodel: z.string(),",
        "\t\treasoningEffort: z.string(),",
        "\t\tmaxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)",
        "\t}).default(void 0),",
        "\tpersona: z.string(),"
      )),
      operation("per-call-route-schema", block(
        "\t\t\t\tprompt: {",
        "\t\t\t\t\ttype: \"string\",",
        "\t\t\t\t\trequired: true,",
        "\t\t\t\t\tdescription: wording.promptDescription",
        "\t\t\t\t},",
        "\t\t\t\t...backgroundEnabled ? { run_in_background: {"
      ), block(
        "\t\t\t\tprompt: {",
        "\t\t\t\t\ttype: \"string\",",
        "\t\t\t\t\trequired: true,",
        "\t\t\t\t\tdescription: wording.promptDescription",
        "\t\t\t\t},",
        "\t\t\t\tprovider: {",
        "\t\t\t\t\ttype: \"string\",",
        "\t\t\t\t\tdescription: \"Optional LLM provider override for this child; may be supplied independently of model.\"",
        "\t\t\t\t},",
        "\t\t\t\tmodel: {",
        "\t\t\t\t\ttype: \"string\",",
        "\t\t\t\t\tdescription: \"Optional model override for this child; may be supplied independently of provider.\"",
        "\t\t\t\t},",
        "\t\t\t\treasoning_effort: {",
        "\t\t\t\t\ttype: \"string\",",
        "\t\t\t\t\tdescription: \"Optional provider/model-specific reasoning effort override (for example xhigh or max); the selected adapter validates it.\"",
        "\t\t\t\t},",
        "\t\t\t\t...backgroundEnabled ? { run_in_background: {"
      )),
      operation("per-call-route-merge", block(
        "\t\t\t\tconst maxDepth = typeof config.maxDepth === \"number\" ? config.maxDepth : void 0;",
        "\t\t\t\tconst request = {",
        "\t\t\t\t\tlabel: args.description,",
        "\t\t\t\t\tprompt: [{",
        "\t\t\t\t\t\ttype: \"text\",",
        "\t\t\t\t\t\ttext: args.prompt",
        "\t\t\t\t\t}],",
        "\t\t\t\t\tparent,",
        "\t\t\t\t\t...config.agentOptions !== void 0 ? { agentOptions: config.agentOptions } : {},"
      ), block(
        "\t\t\t\tconst maxDepth = typeof config.maxDepth === \"number\" ? config.maxDepth : void 0;",
        "\t\t\t\tconst hasAgentOptions = config.agentOptions !== void 0 || args.provider !== void 0 || args.model !== void 0 || args.reasoning_effort !== void 0;",
        "\t\t\t\t// Per-call route overrides must win over plugin defaults before the",
        "\t\t\t\t// canonical child-option resolver merges them over the parent route.",
        "\t\t\t\tconst agentOptions = {",
        "\t\t\t\t\t...(config.agentOptions ?? {}),",
        "\t\t\t\t\t...args.provider !== void 0 ? { provider: args.provider } : {},",
        "\t\t\t\t\t...args.model !== void 0 ? { model: args.model } : {},",
        "\t\t\t\t\t...args.reasoning_effort !== void 0 ? { reasoningEffort: args.reasoning_effort } : {}",
        "\t\t\t\t};",
        "\t\t\t\tconst request = {",
        "\t\t\t\t\tlabel: args.description,",
        "\t\t\t\t\tprompt: [{",
        "\t\t\t\t\t\ttype: \"text\",",
        "\t\t\t\t\t\ttext: args.prompt",
        "\t\t\t\t\t}],",
        "\t\t\t\t\tparent,",
        "\t\t\t\t\t...hasAgentOptions ? { agentOptions } : {},"
      ))
    ],
    assertions: [
      assertion("tool-reasoning-parameter", "reasoning_effort: {"),
      assertion("tool-reasoning-merge", "...args.reasoning_effort !== void 0 ? { reasoningEffort: args.reasoning_effort } : {}")
    ]
  },
  {
    id: "subagent-runtime",
    package: "@deepseek-ai/dsh-subagent",
    path: "node_modules/@deepseek-ai/dsh-subagent/lib/index.js",
    sourceSha256: "555ab9189cc4baa7cd2b527099b932497310a6a609798a4d5cff30fa89349c5a",
    appliedSha256: "bb9a22b91140d94dbfde288621f8bb2b0f880227e64d7ad05f1ecb9249bbe93c",
    operations: [
      operation("descriptor-version", block(
        "* Supporting another composition input is a deliberate version change, never",
        "* an implicit extra field.",
        "*/",
        "const SUBAGENT_DESCRIPTOR_VERSION = 2;",
        "const DESCRIPTOR_BASE_KEYS = [",
        "\t\"version\",",
        "\t\"mode\","
      ), block(
        "* Supporting another composition input is a deliberate version change, never",
        "* an implicit extra field.",
        "*/",
        "const SUBAGENT_DESCRIPTOR_VERSION = 3;",
        "const DESCRIPTOR_BASE_KEYS = [",
        "\t\"version\",",
        "\t\"mode\","
      )),
      operation("descriptor-key-sets", block(
        "\t\"label\"",
        "];",
        "const ONE_SHOT_DESCRIPTOR_KEYS = new Set(DESCRIPTOR_BASE_KEYS);",
        "const CONTINUABLE_DESCRIPTOR_KEYS = new Set([",
        "\t...DESCRIPTOR_BASE_KEYS,",
        "\t\"agentProvider\",",
        "\t\"agentModel\",",
        "\t\"persona\",",
        "\t\"toolFilter\"",
        "]);",
        "const TOOL_FILTER_KEYS = new Set([\"allow\", \"deny\"]);",
        "/** Whether a persisted JSON value is an object record. */"
      ), block(
        "\t\"label\"",
        "];",
        "const ONE_SHOT_DESCRIPTOR_KEYS = new Set(DESCRIPTOR_BASE_KEYS);",
        "const CONTINUABLE_DESCRIPTOR_KEYS_V2 = new Set([",
        "\t...DESCRIPTOR_BASE_KEYS,",
        "\t\"agentProvider\",",
        "\t\"agentModel\",",
        "\t\"persona\",",
        "\t\"toolFilter\"",
        "]);",
        "const CONTINUABLE_DESCRIPTOR_KEYS_V3 = new Set([",
        "\t...CONTINUABLE_DESCRIPTOR_KEYS_V2,",
        "\t\"agentReasoningEffort\"",
        "]);",
        "const TOOL_FILTER_KEYS = new Set([\"allow\", \"deny\"]);",
        "/** Whether a persisted JSON value is an object record. */"
      )),
      operation("descriptor-fold-version", block(
        "\tif (!isRecord(value)) throw new Error(\"persisted subagent descriptor payload must be an object\");",
        "\tconst version = value[\"version\"];",
        "\tif (typeof version !== \"number\") throw new Error(\"persisted subagent descriptor version must be a number\");",
        "\tif (version !== 2) return void 0;",
        "\tconst mode = value[\"mode\"];",
        "\tif (mode !== \"one-shot\" && mode !== \"continuable\") throw new Error(\"persisted subagent descriptor mode must be \\\"one-shot\\\" or \\\"continuable\\\"\");",
        "\tassertKnownKeys(value, mode === \"one-shot\" ? ONE_SHOT_DESCRIPTOR_KEYS : CONTINUABLE_DESCRIPTOR_KEYS, \"payload\");",
        "\tconst provider = value[\"provider\"];",
        "\tif (typeof provider !== \"string\") throw new Error(\"persisted subagent descriptor provider must be a string\");",
        "\tif (mode === \"one-shot\") {",
        "\t\tconst label = optionalString(value, \"label\");",
        "\t\treturn {",
        "\t\t\tversion: 2,",
        "\t\t\tmode,"
      ), block(
        "\tif (!isRecord(value)) throw new Error(\"persisted subagent descriptor payload must be an object\");",
        "\tconst version = value[\"version\"];",
        "\tif (typeof version !== \"number\") throw new Error(\"persisted subagent descriptor version must be a number\");",
        "\tif (version !== 2 && version !== SUBAGENT_DESCRIPTOR_VERSION) return void 0;",
        "\tconst mode = value[\"mode\"];",
        "\tif (mode !== \"one-shot\" && mode !== \"continuable\") throw new Error(\"persisted subagent descriptor mode must be \\\"one-shot\\\" or \\\"continuable\\\"\");",
        "\tconst knownKeys = mode === \"one-shot\" ? ONE_SHOT_DESCRIPTOR_KEYS : version === 2 ? CONTINUABLE_DESCRIPTOR_KEYS_V2 : CONTINUABLE_DESCRIPTOR_KEYS_V3;",
        "\tassertKnownKeys(value, knownKeys, \"payload\");",
        "\tconst provider = value[\"provider\"];",
        "\tif (typeof provider !== \"string\") throw new Error(\"persisted subagent descriptor provider must be a string\");",
        "\tif (mode === \"one-shot\") {",
        "\t\tconst label = optionalString(value, \"label\");",
        "\t\treturn {",
        "\t\t\tversion,",
        "\t\t\tmode,"
      )),
      operation("descriptor-fields-and-snapshot", block(
        "\tif (typeof label !== \"string\") throw new Error(\"persisted subagent descriptor label must be a string\");",
        "\tconst agentProvider = optionalString(value, \"agentProvider\");",
        "\tconst agentModel = optionalString(value, \"agentModel\");",
        "\tconst persona = optionalString(value, \"persona\");",
        "\tconst toolFilter = Object.hasOwn(value, \"toolFilter\") ? parseToolFilter(value[\"toolFilter\"]) : void 0;",
        "\treturn {",
        "\t\tversion: 2,",
        "\t\tmode,",
        "\t\tprovider,",
        "\t\tlabel,",
        "\t\t...agentProvider !== void 0 ? { agentProvider } : {},",
        "\t\t...agentModel !== void 0 ? { agentModel } : {},",
        "\t\t...persona !== void 0 ? { persona } : {},",
        "\t\t...toolFilter !== void 0 ? { toolFilter } : {}",
        "\t};",
        "}",
        "function snapshotSubagentDescriptor(input) {",
        "\tconst snapshot = snapshotJsonValue(input.mode === \"one-shot\" ? {",
        "\t\tversion: 2,"
      ), block(
        "\tif (typeof label !== \"string\") throw new Error(\"persisted subagent descriptor label must be a string\");",
        "\tconst agentProvider = optionalString(value, \"agentProvider\");",
        "\tconst agentModel = optionalString(value, \"agentModel\");",
        "\tconst agentReasoningEffort = version === SUBAGENT_DESCRIPTOR_VERSION ? optionalString(value, \"agentReasoningEffort\") : void 0;",
        "\tconst persona = optionalString(value, \"persona\");",
        "\tconst toolFilter = Object.hasOwn(value, \"toolFilter\") ? parseToolFilter(value[\"toolFilter\"]) : void 0;",
        "\treturn {",
        "\t\tversion,",
        "\t\tmode,",
        "\t\tprovider,",
        "\t\tlabel,",
        "\t\t...agentProvider !== void 0 ? { agentProvider } : {},",
        "\t\t...agentModel !== void 0 ? { agentModel } : {},",
        "\t\t...agentReasoningEffort !== void 0 ? { agentReasoningEffort } : {},",
        "\t\t...persona !== void 0 ? { persona } : {},",
        "\t\t...toolFilter !== void 0 ? { toolFilter } : {}",
        "\t};",
        "}",
        "function snapshotSubagentDescriptor(input) {",
        "\tconst snapshot = snapshotJsonValue(input.mode === \"one-shot\" ? {",
        "\t\tversion: SUBAGENT_DESCRIPTOR_VERSION,"
      )),
      operation("parent-route-resolution", block(
        "function resolveChildAgentOptions(parent, requested, childDepth) {",
        "\tconst parentProvider = parent.options.provider;",
        "\tconst parentModel = parent.options.model;",
        "\tconst parentMaxTokens = parent.options.maxTokens;",
        "\treturn {",
        "\t\t...parentProvider !== void 0 ? { provider: parentProvider } : {},",
        "\t\t...parentModel !== void 0 ? { model: parentModel } : {},",
        "\t\t...parentMaxTokens !== void 0 ? { maxTokens: parentMaxTokens } : {},",
        "\t\t...requested,",
        "\t\tsubagentDepth: childDepth",
        "\t};",
        "}"
      ), block(
        "function resolveChildAgentOptions(parent, requested, childDepth) {",
        "\tconst parentHeader = parent.session?.requestHeader?.();",
        "\tconst parentConfig = parentHeader?.config;",
        "\tconst parentAdapterDefaults = parentHeader?.adapterDefaults;",
        "\tconst parentProvider = parentHeader !== void 0 ? parentConfig?.provider : parent.options.provider;",
        "\tconst parentModel = parentHeader !== void 0 ? parentConfig?.model : parent.options.model;",
        "\tconst parentReasoningEffort = parentHeader !== void 0 ? parentAdapterDefaults?.reasoningEffort === true ? void 0 : parentConfig?.reasoningEffort : parent.options.reasoningEffort;",
        "\tconst parentMaxTokens = parentHeader !== void 0 ? parentAdapterDefaults?.maxTokens === true ? void 0 : parentConfig?.maxTokens : parent.options.maxTokens;",
        "\tconst routeChanged = requested?.provider !== void 0 && requested.provider !== parentProvider || requested?.model !== void 0 && requested.model !== parentModel;",
        "\tconst reasoningEffort = requested?.reasoningEffort !== void 0 ? requested.reasoningEffort : routeChanged ? void 0 : parentReasoningEffort;",
        "\treturn {",
        "\t\t...parentProvider !== void 0 ? { provider: parentProvider } : {},",
        "\t\t...parentModel !== void 0 ? { model: parentModel } : {},",
        "\t\t...parentMaxTokens !== void 0 ? { maxTokens: parentMaxTokens } : {},",
        "\t\t...requested,",
        "\t\t...reasoningEffort !== void 0 ? { reasoningEffort } : {},",
        "\t\tsubagentDepth: childDepth",
        "\t};",
        "}"
      )),
      operation("continuable-descriptor", block(
        "\t\tconst childId = spec.childId ?? SessionId(randomUUID());",
        "\t\tthis.assertChildIdAvailable(childId);",
        "\t\tconst childDepth = resolveChildDepth(parent, request.maxDepth);",
        "\t\tconst agentProvider = request.agentOptions?.provider ?? parent.options.provider;",
        "\t\tconst agentModel = request.agentOptions?.model ?? parent.options.model;",
        "\t\tconst descriptor = snapshotSubagentDescriptor({",
        "\t\t\tmode: \"continuable\",",
        "\t\t\tprovider: spec.provider,",
        "\t\t\tlabel: spec.label,",
        "\t\t\t...agentProvider !== void 0 ? { agentProvider } : {},",
        "\t\t\t...agentModel !== void 0 ? { agentModel } : {},",
        "\t\t\t...request.persona !== void 0 ? { persona: request.persona } : {},",
        "\t\t\t...request.toolFilter !== void 0 ? { toolFilter: request.toolFilter } : {}",
        "\t\t});"
      ), block(
        "\t\tconst childId = spec.childId ?? SessionId(randomUUID());",
        "\t\tthis.assertChildIdAvailable(childId);",
        "\t\tconst childDepth = resolveChildDepth(parent, request.maxDepth);",
        "\t\tconst childAgentOptions = resolveChildAgentOptions(parent, request.agentOptions, childDepth);",
        "\t\tconst descriptor = snapshotSubagentDescriptor({",
        "\t\t\tmode: \"continuable\",",
        "\t\t\tprovider: spec.provider,",
        "\t\t\tlabel: spec.label,",
        "\t\t\t...childAgentOptions.provider !== void 0 ? { agentProvider: childAgentOptions.provider } : {},",
        "\t\t\t...childAgentOptions.model !== void 0 ? { agentModel: childAgentOptions.model } : {},",
        "\t\t\t...childAgentOptions.reasoningEffort !== void 0 ? { agentReasoningEffort: childAgentOptions.reasoningEffort } : {},",
        "\t\t\t...request.persona !== void 0 ? { persona: request.persona } : {},",
        "\t\t\t...request.toolFilter !== void 0 ? { toolFilter: request.toolFilter } : {}",
        "\t\t});"
      )),
      operation("continuable-options", "\t\t\t\t\tagentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),", "\t\t\t\t\tagentOptions: childAgentOptions,"),
      operation("cold-resume-effort", block(
        "\t\t\t\tagentOptions: {",
        "\t\t\t\t\t...descriptor.agentProvider !== void 0 ? { provider: descriptor.agentProvider } : {},",
        "\t\t\t\t\t...descriptor.agentModel !== void 0 ? { model: descriptor.agentModel } : {}",
        "\t\t\t\t},",
        "\t\t\t\tcomposition: {"
      ), block(
        "\t\t\t\tagentOptions: {",
        "\t\t\t\t\t...descriptor.agentProvider !== void 0 ? { provider: descriptor.agentProvider } : {},",
        "\t\t\t\t\t...descriptor.agentModel !== void 0 ? { model: descriptor.agentModel } : {},",
        "\t\t\t\t\t...descriptor.agentReasoningEffort !== void 0 ? { reasoningEffort: descriptor.agentReasoningEffort } : {}",
        "\t\t\t\t},",
        "\t\t\t\tcomposition: {"
      ))
    ],
    assertions: [
      assertion("descriptor-v3", "const SUBAGENT_DESCRIPTOR_VERSION = 3;"),
      assertion("request-header-authority", "const parentHeader = parent.session?.requestHeader?.();"),
      assertion("descriptor-effort", "\"agentReasoningEffort\"", 2)
    ]
  }
];

export const DSH_RC2_COMPATIBILITY_RECIPE = Object.freeze({
  schemaVersion: 1,
  id: "dsh-0.1.1-rc.2-ricardo-compat-3",
  dsh: Object.freeze({
    name: "@deepseek-ai/dsh",
    version: "0.1.1-rc.2"
  }),
  routePolicy,
  restartGoalTicket,
  targets
});
