// Next.js Node runtime. SENTRY_DSN is read at container start, not build.
import * as Sentry from "@sentry/nextjs";
import { initializeSentryIfEnabled, serverSentryOptions } from "@/app/lib/errorReporting";

initializeSentryIfEnabled(serverSentryOptions("server", process.env), (options) => Sentry.init(options));
