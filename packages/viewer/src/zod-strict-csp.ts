import { z } from "zod";

// The Viewer intentionally forbids eval. Configure Zod before contract schemas load
// so its optional JIT capability probe does not trigger strict-CSP diagnostics.
z.config({ jitless: true });
