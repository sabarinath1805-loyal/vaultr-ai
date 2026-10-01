// Next.js edge runtime (middleware/proxy, if any is ever added).
import * as Sentry from "@sentry/nextjs";
import { initializeSentryIfEnabled, serverSentryOptions } from "@/app/lib/errorReporting";

initializeSentryIfEnabled(serverSentryOptions("edge", process.env), (options) => Sentry.init(options));
