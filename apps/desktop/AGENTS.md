# Frontend Agent Guide

- Organize code by feature.
- Keep visual components declarative.
- Wrap Tauri in `bindings` or in the feature's API.
- Do not call `invoke` directly from components.
- Prefer local state; global state needs clear consumers and lifecycle.
- Virtualize lists whose size depends on user data.
- Cover loading, empty, success and error states.
- Preserve keyboard navigation and focus.
- Do not hand-duplicate DTOs that can be generated or validated.
- Do not move code into `shared` before real reuse exists.
